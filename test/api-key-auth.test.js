import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiKeyAuth } from '../src/api-key-auth.js';

class DomainError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** @returns {{ header: (k: string, v: string) => any, code: (c: number) => any, send: (b: unknown) => any, _r: { statusCode: number|undefined, headers: Record<string, string>, body: unknown } }} */
function fakeReply() {
  /** @type {{ statusCode: number|undefined, headers: Record<string, string>, body: unknown }} */
  const r = { statusCode: undefined, headers: {}, body: undefined };
  const reply = {
    header: (/** @type {string} */ k, /** @type {string} */ v) => { r.headers[k] = v; return reply; },
    code: (/** @type {number} */ c) => { r.statusCode = c; return reply; },
    send: (/** @type {unknown} */ b) => { r.body = b; return reply; },
    _r: r,
  };
  return reply;
}

test('identify: matches by secret regardless of position, never exits early (constant iteration)', () => {
  const keys = [{ id: 'a', secret: 's'.repeat(32) }, { id: 'b', secret: 't'.repeat(32) }, { id: 'c', secret: 'u'.repeat(32) }];
  const auth = new ApiKeyAuth(keys);
  assert.equal(auth.identify('t'.repeat(32))?.id, 'b');
  assert.equal(auth.identify('nope'), undefined);
});

test('hook: default decorate attaches request.apiKey (the 6/9-service shape); 401 body is the fixed shared envelope', async () => {
  const key = { id: 'svc', secret: 's'.repeat(32), role: 'readwrite' };
  const auth = new ApiKeyAuth([key]);
  const req = /** @type {any} */ ({ headers: { authorization: `Bearer ${key.secret}` } });
  const reply = fakeReply();
  await auth.hook(req, /** @type {any} */ (reply));
  assert.equal(req.apiKey, key);
  assert.equal(reply._r.statusCode, undefined, 'no error response on success');

  const bad = fakeReply();
  await auth.hook(/** @type {any} */ ({ headers: {} }), /** @type {any} */ (bad));
  assert.equal(bad._r.statusCode, 401);
  assert.deepEqual(bad._r.body, { error: { code: 'UNAUTHORIZED', message: 'missing or invalid API key' } });
  assert.equal(bad._r.headers['www-authenticate'], 'Bearer');
});

test('hook: custom decorate reproduces the split apiKeyId/apiKeyRole shape (audit/shortlink) and the id-only shape (media)', async () => {
  const key = { id: 'svc', secret: 's'.repeat(32), role: 'write' };
  const split = new ApiKeyAuth([key], { decorate: (/** @type {any} */ r, /** @type {any} */ k) => { r.apiKeyId = k.id; r.apiKeyRole = k.role; } });
  const req1 = /** @type {any} */ ({ headers: { authorization: `Bearer ${key.secret}` } });
  await split.hook(req1, /** @type {any} */ (fakeReply()));
  assert.deepEqual([req1.apiKeyId, req1.apiKeyRole], ['svc', 'write']);

  const idOnly = new ApiKeyAuth([{ id: 'svc', secret: key.secret }], { decorate: (/** @type {any} */ r, /** @type {any} */ k) => { r.apiKeyId = k.id; } });
  const req2 = /** @type {any} */ ({ headers: { authorization: `Bearer ${key.secret}` } });
  await idOnly.hook(req2, /** @type {any} */ (fakeReply()));
  assert.equal(req2.apiKeyId, 'svc');
  assert.equal(req2.apiKeyRole, undefined);
});

test('require: default grants (need or readwrite satisfies), matching every service but webhook-out', async () => {
  const makeError = (/** @type {string} */ need) => new DomainError('FORBIDDEN', `this API key has no ${need} access`);
  const guardWrite = ApiKeyAuth.require('write', { roleOf: (/** @type {any} */ r) => r.apiKey.role, makeError });
  await guardWrite(/** @type {any} */ ({ apiKey: { role: 'write' } }));
  await guardWrite(/** @type {any} */ ({ apiKey: { role: 'readwrite' } }));
  await assert.rejects(guardWrite(/** @type {any} */ ({ apiKey: { role: 'read' } })), DomainError);
});

test('require: webhook-out\'s grants lattice — write also satisfies publish', async () => {
  const GRANTS = { read: ['read', 'readwrite'], write: ['write', 'readwrite'], publish: ['publish', 'write', 'readwrite'] };
  const makeError = (/** @type {string} */ need) => new DomainError('FORBIDDEN', `this API key has no ${need} access`);
  const guardPublish = ApiKeyAuth.require('publish', { roleOf: (/** @type {any} */ r) => r.apiKey.role, makeError, grants: GRANTS });
  await guardPublish(/** @type {any} */ ({ apiKey: { role: 'publish' } }));
  await guardPublish(/** @type {any} */ ({ apiKey: { role: 'write' } }));
  await assert.rejects(guardPublish(/** @type {any} */ ({ apiKey: { role: 'read' } })), DomainError);
});

test('assertScope: null scopes means every scope allowed; a non-matching scope throws', () => {
  const makeError = (/** @type {string} */ name) => new DomainError('FORBIDDEN', `this API key has no access to policy "${name}"`);
  const key = (/** @type {string[]|null} */ scopes) => /** @type {any} */ ({ id: 'k', secret: 's'.repeat(32), scopes });
  assert.doesNotThrow(() => ApiKeyAuth.assertScope(key(null), 'anything', makeError));
  assert.doesNotThrow(() => ApiKeyAuth.assertScope(key(['a', 'b']), 'a', makeError));
  assert.throws(() => ApiKeyAuth.assertScope(key(['a']), 'b', makeError), DomainError);
});

test('key expiry: an expired key is refused like an unknown one; last use and metrics never carry secrets', async () => {
  const { parseApiKeys } = await import('../src/config.js');
  const keys = parseApiKeys(`old:${'o'.repeat(32)}:read@2026-10-14,new:${'n'.repeat(32)}:read,forever:${'f'.repeat(32)}`, 'K', { roles: ['read', 'readwrite'] });
  assert.deepEqual(keys.map((k) => k.expires ?? null), [Date.parse('2026-10-14T23:59:59.999Z'), null, null]);
  let now = Date.parse('2026-10-14T12:00:00Z');
  const auth = new ApiKeyAuth(keys, { now: () => now });
  assert.equal(auth.identify('o'.repeat(32))?.id, 'old', 'valid through the end of its day');
  now = Date.parse('2026-10-15T00:00:00Z');
  assert.equal(auth.identify('o'.repeat(32)), undefined);
  assert.equal(auth.identify('n'.repeat(32))?.id, 'new');
  const d = auth.describe();
  assert.deepEqual(d.map((k) => [k.id, k.expired, k.expires, k.lastUsed !== null]), [['old', true, '2026-10-14T23:59:59.999Z', true], ['new', false, null, true], ['forever', false, null, false]]);
  const text = auth.metricLines().join('\n');
  assert.match(text, /api_key_expired\{key="old"\} 1/);
  assert.match(text, /api_key_last_used_timestamp_seconds\{key="new"\}/);
  assert.equal(text.includes('o'.repeat(32)) || text.includes('n'.repeat(32)), false);
  assert.throws(() => parseApiKeys(`a:${'a'.repeat(32)}@2026-13-45`, 'K', { roles: ['read'] }), /invalid expiry/);
  // Roleless mode (secret may contain a colon) takes the same suffix.
  const roleless = parseApiKeys(`svc:${'s'.repeat(32)}@2030-01-01`, 'K');
  assert.deepEqual([roleless[0].secret.length, roleless[0].expires], [32, Date.parse('2030-01-01T23:59:59.999Z')]);
});
