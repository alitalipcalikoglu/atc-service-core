import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuditClient } from '../src/audit-client.js';

/** @param {{ status?: number, ok?: boolean, text?: string, throws?: boolean }[]} responses @returns {typeof fetch & { calls: { url: unknown, opts: unknown }[] }} */
function fakeFetch(responses) {
  let i = 0;
  /** @type {{ url: unknown, opts: unknown }[]} */
  const calls = [];
  const fn = async (/** @type {unknown} */ url, /** @type {unknown} */ opts) => {
    calls.push({ url, opts });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    if (r.throws) throw new Error('network down');
    return { ok: r.ok ?? (r.status ?? 200) < 400, status: r.status ?? 200, text: async () => r.text ?? '' };
  };
  fn.calls = calls;
  return /** @type {any} */ (fn);
}

function nullLogger() {
  return { warn() {}, error() {} };
}

/** In-memory stand-in for a real SQLite outbox table, for testing AuditClient's drain loop in isolation. */
class FakeOutbox {
  constructor() {
    /** @type {{ id: string, at: number, payload: string, sentAt: number|null }[]} */
    this.rows = [];
    this.purgeCalls = 0;
  }

  /** @param {string} id @param {object} event @param {number} [at] */
  insert(id, event, at = Date.now()) {
    this.rows.push({ id, at, payload: JSON.stringify(event), sentAt: null });
  }

  /** @param {number} limit */
  pending(limit) {
    return this.rows.filter((r) => r.sentAt === null).slice(0, limit).map(({ id, at, payload }) => ({ id, at, payload }));
  }

  /** @param {string[]} ids */
  markSent(ids) {
    for (const row of this.rows) if (ids.includes(row.id)) row.sentAt = Date.now();
  }

  purge() {
    this.purgeCalls++;
  }
}

test('AuditClient: disabled (no target) — record/start/flush/close are all safe no-ops', async () => {
  const client = new AuditClient({ target: null, logger: nullLogger() });
  assert.equal(client.enabled, false);
  assert.equal(client.record({ action: 'x.y' }), false);
  client.start();
  await client.flush();
  await client.close();
});

test('AuditClient: record buffers, flush sends a batch, hook records success/denied only', async () => {
  const fetch = fakeFetch([{ status: 200 }]);
  const client = new AuditClient({ target: { url: 'http://audit.test/', apiKey: 'k'.repeat(32) }, logger: nullLogger(), fetch, sleep: async () => {} });
  client.record({ action: 'svc.thing.create' });
  assert.equal(client.buffer.length, 1);
  await client.flush();
  assert.equal(client.buffer.length, 0, 'sent events leave the buffer');
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].url, 'http://audit.test/v1/events/batch');
  assert.equal(/** @type {any} */ (fetch.calls[0].opts).headers.authorization, `Bearer ${'k'.repeat(32)}`);
});

test('AuditClient: 4xx (not 429) drops the batch permanently; network error and 429 keep it for retry', async () => {
  const drop = new AuditClient({ target: { url: 'http://a.test', apiKey: 'k'.repeat(32) }, logger: nullLogger(), fetch: fakeFetch([{ status: 400, text: 'bad' }]), sleep: async () => {} });
  drop.record({ action: 'x' });
  await drop.flush();
  assert.equal(drop.buffer.length, 0, '4xx != 429 is dropped, not retried');
  assert.equal(drop.stats.dropped, 1);

  const retry = new AuditClient({ target: { url: 'http://a.test', apiKey: 'k'.repeat(32) }, logger: nullLogger(), fetch: fakeFetch([{ throws: true }]), sleep: async () => {} });
  retry.record({ action: 'x' });
  await retry.flush();
  assert.equal(retry.buffer.length, 1, 'network error is retried later, event stays buffered');
  assert.equal(retry.stats.failed, 1);
});

test('AuditClient: buffer overflow drops the oldest event', () => {
  const client = new AuditClient({ target: { url: 'http://a.test', apiKey: 'k'.repeat(32) }, logger: nullLogger() });
  AuditClient.MAX_BUFFER = 2;
  try {
    client.record({ action: 'a' });
    client.record({ action: 'b' });
    client.record({ action: 'c' });
    assert.equal(client.buffer.length, 2);
    assert.equal(client.buffer[0].action, 'b', 'oldest ("a") was dropped');
  } finally {
    AuditClient.MAX_BUFFER = 5_000;
  }
});

test('AuditClient.hook: records success under 400, denied on 403, nothing on other errors or when disabled', async () => {
  const client = new AuditClient({ target: { url: 'http://a.test', apiKey: 'k'.repeat(32) }, logger: nullLogger() });
  const hook = /** @type {any} */ (AuditClient.hook(client));
  const cfg = { audit: AuditClient.route('svc.thing.create', () => ({ type: 'thing', id: '1' })) };

  const request = /** @type {any} */ ({ routeOptions: { config: cfg }, id: 'req-1', ip: '1.2.3.4', headers: {}, apiKey: { id: 'caller' } });
  await hook(request, /** @type {any} */ ({ statusCode: 201 }), '{"ok":true}');
  assert.equal(client.buffer.length, 1);
  assert.equal(client.buffer[0].outcome, 'success');
  assert.equal(client.buffer[0].actor?.id, 'caller');

  client.buffer.length = 0;
  await hook(request, /** @type {any} */ ({ statusCode: 403 }), '{}');
  assert.equal(client.buffer[0].outcome, 'denied');

  client.buffer.length = 0;
  await hook(request, /** @type {any} */ ({ statusCode: 500 }), '{}');
  assert.equal(client.buffer.length, 0, 'errors other than 403 are not audited');

  client.buffer.length = 0;
  await hook(/** @type {any} */ ({ routeOptions: {}, id: 'req-2', ip: '1.2.3.4', headers: {} }), /** @type {any} */ ({ statusCode: 200 }), '{}');
  assert.equal(client.buffer.length, 0, 'a route with no config.audit is never audited');
});

test('AuditClient outbox mode: record() is refused — inserting is the caller\'s job', () => {
  const client = new AuditClient({ target: { url: 'http://a.test', apiKey: 'k'.repeat(32) }, logger: nullLogger(), outbox: new FakeOutbox() });
  assert.throws(() => client.record({ action: 'x' }), /not used in outbox mode/);
});

test('AuditClient outbox mode: flush drains pending rows using their own stable id, marks them sent, and purges once per tick', async () => {
  const outbox = new FakeOutbox();
  outbox.insert('id-1', { action: 'atc-auth.user.create', outcome: 'success' }, 1_700_000_000_000);
  outbox.insert('id-2', { action: 'atc-auth.user.login', outcome: 'success' }, 1_700_000_001_000);
  const fetch = fakeFetch([{ status: 200 }]);
  const client = new AuditClient({ target: { url: 'http://a.test', apiKey: 'k'.repeat(32) }, logger: nullLogger(), fetch, sleep: async () => {}, outbox });

  await client.flush();

  assert.equal(fetch.calls.length, 1);
  const body = JSON.parse(/** @type {any} */ (fetch.calls[0].opts).body);
  assert.deepEqual(body.events.map((/** @type {any} */ e) => e.id), ['id-1', 'id-2'], 'the row\'s own stable id is sent, not a freshly generated one');
  assert.equal(body.events[0].at, new Date(1_700_000_000_000).toISOString());
  assert.equal(body.events[0].action, 'atc-auth.user.create');
  assert.equal(outbox.rows.every((r) => r.sentAt !== null), true, 'both rows marked sent after a successful send');
  assert.equal(outbox.purgeCalls, 1);
});

test('AuditClient outbox mode: a failed send leaves rows pending (not marked sent) for the next flush — this is the at-least-once/duplicate-retry path', async () => {
  const outbox = new FakeOutbox();
  outbox.insert('id-1', { action: 'atc-auth.user.create' });
  const client = new AuditClient({ target: { url: 'http://a.test', apiKey: 'k'.repeat(32) }, logger: nullLogger(), fetch: fakeFetch([{ throws: true }]), sleep: async () => {}, outbox });

  await client.flush();
  assert.equal(outbox.rows[0].sentAt, null, 'not marked sent — a real crash-before-ack looks identical to this, and must resend, not lose, the event');

  // A retry after the target recovers uses the exact same row id — this is what makes the
  // resend a safe duplicate on the receiving end (audit's UNIQUE(source, client_id)) rather than a
  // second, distinct event.
  client.fetch = fakeFetch([{ status: 200 }]);
  await client.flush();
  const sentId = /** @type {any} */ (client.fetch).calls[0] === undefined ? null : JSON.parse(/** @type {any} */ (client.fetch).calls[0].opts.body).events[0].id;
  assert.equal(sentId, 'id-1');
  assert.notEqual(outbox.rows[0].sentAt, null);
});

test('AuditClient outbox mode: more pending rows than one batch drains in multiple batches, oldest first', async () => {
  const outbox = new FakeOutbox();
  for (let i = 0; i < 5; i++) outbox.insert(`id-${i}`, { action: 'x' }, 1_700_000_000_000 + i);
  const fetch = fakeFetch([{ status: 200 }]);
  const client = new AuditClient({ target: { url: 'http://a.test', apiKey: 'k'.repeat(32) }, logger: nullLogger(), fetch, sleep: async () => {}, outbox, batchSize: 2 });

  await client.flush();

  assert.equal(fetch.calls.length, 3, '5 rows at batchSize 2 -> 3 batches (2, 2, 1)');
  assert.equal(outbox.rows.every((r) => r.sentAt !== null), true);
  const firstBatchIds = JSON.parse(/** @type {any} */ (fetch.calls[0].opts).body).events.map((/** @type {any} */ e) => e.id);
  assert.deepEqual(firstBatchIds, ['id-0', 'id-1'], 'oldest rows first');
});
