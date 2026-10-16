import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import Fastify from 'fastify';
import { AuditClient } from '../src/audit-client.js';
import { Idempotency } from '../src/idempotency.js';
import { Ids } from '../src/ids.js';

/** App with one counting POST route, an opt-out route and a failing route. */
async function app(now = () => Date.now()) {
  const raw = new DatabaseSync(':memory:');
  const a = Fastify();
  a.decorateRequest('apiKey', null);
  a.addHook('onRequest', async (r) => { const k = r.headers['x-key']; /** @type {any} */ (r).apiKey = k ? { id: String(k) } : null; });
  Idempotency.register(a, { raw, now });
  let n = 0;
  const on = { config: { idempotent: true } };
  a.post('/things', on, async (r, reply) => reply.code(201).send({ n: ++n, body: r.body }));
  a.post('/fail', on, async (_r, reply) => { n++; return reply.code(422).send({ error: { code: 'NOPE', message: 'x' } }); });
  a.post('/own', async () => ({ n: ++n }));
  a.post('/mfa/setup', async () => ({ secret: `s${++n}` }));
  a.get('/things', async () => ({ n }));
  await a.ready();
  return { a, count: () => n, raw };
}
const post = (/** @type {any} */ a, /** @type {string} */ url, /** @type {object} */ payload, /** @type {Record<string, string>} */ headers = {}) => a.inject({ method: 'POST', url, payload, headers: { 'x-key': 'shop', ...headers } });

test('Idempotency: a repeat replays the stored answer instead of running twice', async () => {
  const { a, count } = await app();
  const first = await post(a, '/things', { x: 1 }, { 'idempotency-key': 'order-42-a' });
  const again = await post(a, '/things', { x: 1 }, { 'idempotency-key': 'order-42-a' });
  assert.deepEqual([first.statusCode, again.statusCode, count()], [201, 201, 1]);
  assert.equal(again.body, first.body);
  assert.equal(again.headers['idempotent-replayed'], 'true');
  assert.equal(first.headers['idempotent-replayed'], undefined);
  assert.equal((await post(a, '/things', { x: 1 }, { 'idempotency-key': 'order-42-a', 'x-key': 'other' })).json().n, 2, 'keys are scoped per API key');
  assert.equal((await post(a, '/things', { x: 1 })).json().n, 3, 'no header: no idempotency');
});

test('Idempotency: mismatch, bad keys, failures are not stored, opt-out routes', async () => {
  const { a, count } = await app();
  await post(a, '/things', { x: 1 }, { 'idempotency-key': 'key-00001' });
  const other = await post(a, '/things', { x: 2 }, { 'idempotency-key': 'key-00001' });
  assert.deepEqual([other.statusCode, other.json().error.code], [409, 'IDEMPOTENCY_MISMATCH']);
  assert.equal((await post(a, '/things', { x: 1 }, { 'idempotency-key': 'short' })).json().error.code, 'INVALID_IDEMPOTENCY_KEY');
  await post(a, '/fail', {}, { 'idempotency-key': 'key-00002' });
  await post(a, '/fail', {}, { 'idempotency-key': 'key-00002' });
  assert.equal(count(), 3, 'a failed request runs again on retry');
  await post(a, '/own', {}, { 'idempotency-key': 'key-00003' });
  await post(a, '/own', {}, { 'idempotency-key': 'key-00003' });
  assert.equal(count(), 5, 'routes that did not opt in are left alone');
  assert.equal((await a.inject({ method: 'POST', url: '/things', payload: {}, headers: { 'idempotency-key': 'key-00004' } })).statusCode, 201, 'unauthenticated: left alone');
});

test('Idempotency: in-progress and expiry', async () => {
  let t = Date.parse('2026-10-16T10:00:00Z');
  const { a, count, raw } = await app(() => t);
  raw.prepare("INSERT INTO service_idempotency (key_id, idem_key, request_hash, state, created_at) VALUES (?, 'key-busy-1', 'h', 'running', ?)").run(`shop|${Idempotency.defaultSubject(/** @type {any} */ ({ headers: {} }))}`, t);
  const busy = await post(a, '/things', {}, { 'idempotency-key': 'key-busy-1' });
  assert.equal(busy.json().error.code, 'IDEMPOTENCY_MISMATCH', 'a different request under the same key is a mismatch even while running');
  raw.prepare("UPDATE service_idempotency SET request_hash = ? WHERE idem_key = 'key-busy-1'").run(
    (await import('node:crypto')).createHash('sha256').update('POST /things\n{}').digest('hex'));
  assert.equal((await post(a, '/things', {}, { 'idempotency-key': 'key-busy-1' })).json().error.code, 'IDEMPOTENCY_IN_PROGRESS');
  t += Idempotency.STALE_MS + 1;
  assert.equal((await post(a, '/things', {}, { 'idempotency-key': 'key-busy-1' })).statusCode, 201, 'a stale running row is taken over');
  await post(a, '/things', {}, { 'idempotency-key': 'key-exp-01' });
  t += Idempotency.TTL_MS + 1;
  await post(a, '/things', {}, { 'idempotency-key': 'key-exp-01' });
  assert.equal(count(), 3, 'after the TTL the key is fresh again');
});

test('AuditClient.hook skips replays', async () => {
  /** @type {any[]} */ const recorded = [];
  const client = /** @type {any} */ ({ enabled: true, record: (/** @type {any} */ e) => recorded.push(e) });
  const raw = new DatabaseSync(':memory:');
  const a = Fastify();
  a.addHook('onRequest', async (r) => { /** @type {any} */ (r).apiKey = { id: 'shop' }; });
  Idempotency.register(a, { raw });
  a.addHook('onSend', AuditClient.hook(client));
  a.post('/x', { config: { idempotent: true, audit: AuditClient.route('svc.thing.create') } }, async () => ({ ok: true }));
  await a.ready();
  for (let i = 0; i < 2; i++) await a.inject({ method: 'POST', url: '/x', payload: {}, headers: { 'idempotency-key': 'audit-k-1' } });
  assert.equal(recorded.length, 1);
});

test('Idempotency: a secret-returning route that did not opt in is never stored or replayed', async () => {
  const { a, count, raw } = await app();
  const one = await post(a, '/mfa/setup', {}, { 'idempotency-key': 'mfa-k-0001', 'x-access-token': 'tok-a' });
  const two = await post(a, '/mfa/setup', {}, { 'idempotency-key': 'mfa-k-0001', 'x-access-token': 'tok-a' });
  assert.notEqual(one.json().secret, two.json().secret);
  assert.equal(count(), 2);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM service_idempotency').get()?.n, 0, 'nothing about the request is stored');
});

test('Idempotency: another identity on the same key is never served the stored answer', async () => {
  const { a, count } = await app();
  await post(a, '/things', { x: 1 }, { 'idempotency-key': 'shared-k-01', 'x-actor': 'ayse' });
  const other = await post(a, '/things', { x: 1 }, { 'idempotency-key': 'shared-k-01', 'x-actor': 'mehmet' });
  assert.equal(other.headers['idempotent-replayed'], undefined);
  const user2 = await post(a, '/things', { x: 1 }, { 'idempotency-key': 'shared-k-01', 'x-access-token': 'tok-b' });
  assert.equal(user2.headers['idempotent-replayed'], undefined);
  assert.equal(count(), 3);
  assert.equal((await post(a, '/things', { x: 1 }, { 'idempotency-key': 'shared-k-01', 'x-actor': 'ayse' })).headers['idempotent-replayed'], 'true');
});

test('Ids: one format, per-kind pattern', () => {
  const id = Ids.create('usr', Date.parse('2026-10-16T10:00:00Z'));
  assert.match(id, Ids.ANY);
  assert.ok(Ids.is('usr', id));
  assert.equal(Ids.is('fil', id), false);
  assert.match(id, /^usr_[0-9a-z]{8}[0-9a-f]{16}$/);
  assert.throws(() => Ids.create('User'), /prefix/);
});
