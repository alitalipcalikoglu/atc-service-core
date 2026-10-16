import { createHash } from 'node:crypto';

/**
 * `Idempotency-Key` for every POST write, the same way in every service. A client that may retry a
 * POST (timeout, lost connection) sends a key of its choosing; the first request runs and its 2xx
 * JSON answer is stored for `ttlMs`; a repeat with the same key and the same request answers the
 * stored response again with `Idempotent-Replayed: true` instead of running twice. The same key
 * with a different method, path or body is `409 IDEMPOTENCY_MISMATCH`; a repeat while the first is
 * still running is `409 IDEMPOTENCY_IN_PROGRESS`. Keys are scoped per API key. Non-2xx answers are
 * not stored, so a failed request can be retried with the same key. Requests without the header,
 * without an authenticated key, with a streamed body, or on routes with `config.idempotency: false`
 * (routes whose domain already deduplicates) are left alone.
 *
 * Rows live in the service's own SQLite file (`service_idempotency`, created on first use, outside
 * the service's migrations), so several processes on one database share them.
 */
export class Idempotency {
  static HEADER = 'idempotency-key';
  static REPLAYED = 'idempotent-replayed';
  static KEY = /^[A-Za-z0-9._:-]{8,255}$/;
  static TTL_MS = 24 * 3_600_000;
  /** A row still "in progress" after this long belongs to a request that died; it may be taken over. */
  static STALE_MS = 120_000;

  /**
   * @param {object} o
   * @param {import('node:sqlite').DatabaseSync} o.raw  The service database connection.
   * @param {number} [o.ttlMs]
   * @param {() => number} [o.now]
   * @param {(request: import('fastify').FastifyRequest) => boolean} [o.skip]  Requests to leave alone, e.g. ones carrying credentials or answering with tokens (never stored).
   */
  constructor({ raw, ttlMs = Idempotency.TTL_MS, now = Date.now, skip = () => false }) {
    this.skip = skip;
    this.ttlMs = ttlMs;
    this.now = now;
    this.inserts = 0;
    raw.exec(`CREATE TABLE IF NOT EXISTS service_idempotency (
      key_id TEXT NOT NULL, idem_key TEXT NOT NULL, request_hash TEXT NOT NULL,
      state TEXT NOT NULL, status INTEGER, content_type TEXT, body TEXT, created_at INTEGER NOT NULL,
      PRIMARY KEY (key_id, idem_key)
    ) WITHOUT ROWID`);
    this.stmt = {
      get: raw.prepare('SELECT request_hash, state, status, content_type, body, created_at FROM service_idempotency WHERE key_id = ? AND idem_key = ?'),
      start: raw.prepare("INSERT INTO service_idempotency (key_id, idem_key, request_hash, state, created_at) VALUES (?, ?, ?, 'running', ?) ON CONFLICT DO NOTHING"),
      done: raw.prepare("UPDATE service_idempotency SET state = 'done', status = ?, content_type = ?, body = ? WHERE key_id = ? AND idem_key = ?"),
      drop: raw.prepare('DELETE FROM service_idempotency WHERE key_id = ? AND idem_key = ?'),
      purge: raw.prepare('DELETE FROM service_idempotency WHERE created_at < ?'),
    };
  }

  /**
   * Install the hooks on a Fastify instance (before its routes are declared).
   * @param {import('fastify').FastifyInstance} app
   * @param {{ raw: import('node:sqlite').DatabaseSync, ttlMs?: number, now?: () => number, skip?: (request: import('fastify').FastifyRequest) => boolean }} o
   */
  static register(app, o) {
    const idem = new Idempotency(o);
    app.addHook('preHandler', async (request, reply) => { if (idem.#before(request, reply)) return reply; });
    app.addHook('onSend', async (request, reply, payload) => { idem.#after(request, reply, payload); return payload; });
    return idem;
  }

  /** @param {import('fastify').FastifyRequest} request */
  static #keyOf(request) {
    const r = /** @type {any} */ (request);
    const id = r.apiKey?.id ?? r.apiKeyId;
    return typeof id === 'string' && id ? id : null;
  }

  /**
   * @param {import('fastify').FastifyRequest} request @param {import('fastify').FastifyReply} reply
   * @returns {boolean} true when this hook answered the request (replay or refusal)
   */
  #before(request, reply) {
    if (request.method !== 'POST') return false;
    const header = request.headers[Idempotency.HEADER];
    if (header === undefined) return false;
    if (/** @type {any} */ (request.routeOptions?.config)?.idempotency === false || this.skip(request)) return false;
    const keyId = Idempotency.#keyOf(request);
    const body = /** @type {any} */ (request.body);
    if (!keyId || (body && typeof body.pipe === 'function')) return false;
    if (typeof header !== 'string' || !Idempotency.KEY.test(header)) {
      reply.code(400).send({ error: { code: 'INVALID_IDEMPOTENCY_KEY', message: 'Idempotency-Key must be 8-255 characters of A-Z a-z 0-9 . _ : -' } });
      return true;
    }
    const hash = createHash('sha256').update(`${request.method} ${request.url}\n${JSON.stringify(body ?? null)}`).digest('hex');
    const now = this.now();
    let row = /** @type {any} */ (this.stmt.get.get(keyId, header));
    if (row && (row.created_at < now - this.ttlMs || (row.state === 'running' && row.created_at < now - Idempotency.STALE_MS))) {
      this.stmt.drop.run(keyId, header);
      row = undefined;
    }
    if (!row) {
      if (Number(this.stmt.start.run(keyId, header, hash, now).changes) === 1) {
        /** @type {any} */ (request).idempotency = { keyId, key: header };
        if (++this.inserts % 100 === 0) this.stmt.purge.run(now - this.ttlMs);
        return false;
      }
      row = /** @type {any} */ (this.stmt.get.get(keyId, header));
    }
    if (row.request_hash !== hash) {
      reply.code(409).send({ error: { code: 'IDEMPOTENCY_MISMATCH', message: 'this Idempotency-Key was used for a different request' } });
    } else if (row.state !== 'done') {
      reply.code(409).send({ error: { code: 'IDEMPOTENCY_IN_PROGRESS', message: 'a request with this Idempotency-Key is still running; retry shortly' } });
    } else {
      reply.code(Number(row.status)).header(Idempotency.REPLAYED, 'true').type(row.content_type).send(row.body);
    }
    return true;
  }

  /**
   * @param {import('fastify').FastifyRequest} request @param {import('fastify').FastifyReply} reply @param {unknown} payload
   */
  #after(request, reply, payload) {
    const own = /** @type {any} */ (request).idempotency;
    if (!own) return;
    /** @type {any} */ (request).idempotency = null;
    const type = String(reply.getHeader('content-type') ?? '');
    const ok = reply.statusCode >= 200 && reply.statusCode < 300 && (typeof payload === 'string' || payload === undefined || payload === null) && (type === '' || type.includes('json'));
    if (ok) this.stmt.done.run(reply.statusCode, type || 'application/json; charset=utf-8', typeof payload === 'string' ? payload : '', own.keyId, own.key);
    else this.stmt.drop.run(own.keyId, own.key);
  }
}
