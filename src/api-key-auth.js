import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * @typedef {{ id: string, secret: string, role?: string, scopes?: string[]|null, expires?: number|null }} ApiKey
 */

/**
 * Bearer API-key authentication. Every configured key is compared in constant time, without an
 * early exit on match, so timing does not reveal whether, or which, key matched — this property is
 * load-bearing and must survive every adoption unchanged.
 *
 * How a matched key is attached to `request`, and what `require()` throws on a role mismatch, both
 * vary per service today (object vs. split `apiKeyId`/`apiKeyRole` vs. `apiKeyId`-only; each
 * service's own domain error class) — both are constructor options precisely so an adoption can
 * reproduce its service's exact current behavior instead of being forced onto one shape.
 */
export class ApiKeyAuth {
  /**
   * @param {ApiKey[]} apiKeys
   * @param {object} [opts]
   * @param {(request: import('fastify').FastifyRequest, key: ApiKey) => void} [opts.decorate]
   *   Default: `request.apiKey = key` (the shape 6 of 9 current services use).
   * @param {() => Error} [opts.unauthorizedError] Not used for the 401 body (that is a fixed,
   *   already-identical-everywhere JSON envelope); reserved for a future divergent case.
   * @param {() => number} [opts.now] Clock for key expiry and last-use tracking.
   */
  constructor(apiKeys, { decorate = (request, key) => { /** @type {any} */ (request).apiKey = key; }, now = Date.now } = {}) {
    this.apiKeys = apiKeys;
    this.decorate = decorate;
    this.now = now;
    /** When each key was last presented successfully (epoch ms), per process. @type {Map<string, number>} */
    this.lastUsed = new Map();
  }

  /**
   * Fastify `onRequest` hook. Arrow property so it can be passed directly to `addHook`.
   * @param {import('fastify').FastifyRequest} request
   * @param {import('fastify').FastifyReply} reply
   */
  hook = async (request, reply) => {
    const header = request.headers.authorization ?? '';
    const secret = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const key = secret ? this.identify(secret) : undefined;
    if (!key) {
      reply.header('www-authenticate', 'Bearer');
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'missing or invalid API key' } });
    }
    this.decorate(request, key);
  };

  /**
   * @param {string} secret Presented secret.
   * @returns {ApiKey|undefined} Matching key.
   */
  identify(secret) {
    /** @type {ApiKey|undefined} */
    let matched;
    for (const key of this.apiKeys) {
      if (ApiKeyAuth.#secretsEqual(secret, key.secret)) matched = key;
    }
    // An expired key is a key that does not exist: same 401, no hint. The constant-time loop above ran either way.
    if (matched?.expires != null && this.now() > matched.expires) return undefined;
    if (matched) this.lastUsed.set(matched.id, this.now());
    return matched;
  }

  /**
   * What an operator may ask about keys: ids, roles, expiry and last use, never secrets.
   * @returns {{ id: string, role: string|null, expires: string|null, lastUsed: string|null, expired: boolean }[]}
   */
  describe() {
    const now = this.now();
    const iso = (/** @type {number|null|undefined} */ ms) => (ms == null ? null : new Date(ms).toISOString());
    return this.apiKeys.map((k) => ({ id: k.id, role: k.role ?? null, expires: iso(k.expires), lastUsed: iso(this.lastUsed.get(k.id)), expired: k.expires != null && now > k.expires }));
  }

  /**
   * Prometheus lines: `api_key_expires_timestamp_seconds` (only keys with an expiry), `api_key_last_used_timestamp_seconds`
   * (only keys used since start) and `api_key_expired` (1 once a key has expired and is refused).
   * @returns {string[]}
   */
  metricLines() {
    const q = (/** @type {string} */ v) => v.replace(/[\\"\n]/g, '\\$&');
    const withExpiry = this.apiKeys.filter((k) => k.expires != null);
    return [
      '# HELP api_key_expires_timestamp_seconds When a configured API key stops working.', '# TYPE api_key_expires_timestamp_seconds gauge',
      ...withExpiry.map((k) => `api_key_expires_timestamp_seconds{key="${q(k.id)}"} ${Math.floor(/** @type {number} */ (k.expires) / 1000)}`),
      '# HELP api_key_expired 1 for a key past its expiry (it is refused).', '# TYPE api_key_expired gauge',
      ...withExpiry.map((k) => `api_key_expired{key="${q(k.id)}"} ${this.now() > /** @type {number} */ (k.expires) ? 1 : 0}`),
      '# HELP api_key_last_used_timestamp_seconds When a key was last presented successfully (since this process started).', '# TYPE api_key_last_used_timestamp_seconds gauge',
      ...[...this.lastUsed].map(([id, at]) => `api_key_last_used_timestamp_seconds{key="${q(id)}"} ${Math.floor(at / 1000)}`),
    ];
  }

  /**
   * Route-level role guard. `grants` maps a required capability to the roles that satisfy it;
   * default is the simple rule every service but webhook-out uses (`need` itself, or `readwrite`).
   * webhook-out's lattice (`write` also satisfies `publish`) is reproduced by passing its own
   * `grants` table — it is service policy, not something core hardcodes.
   * @param {string} need
   * @param {object} opts
   * @param {(request: import('fastify').FastifyRequest) => string|undefined} opts.roleOf How to
   *   read the role back off the request (matches whatever `decorate` attached).
   * @param {(need: string) => Error} opts.makeError Thrown when the role does not satisfy `need`.
   * @param {Record<string, readonly string[]>} [opts.grants]
   */
  static require(need, { roleOf, makeError, grants }) {
    const satisfies = grants ? grants[need] : [need, 'readwrite'];
    /** @param {import('fastify').FastifyRequest} request */
    return async (request) => {
      const role = roleOf(request);
      if (!role || !satisfies.includes(role)) throw makeError(need);
    };
  }

  /**
   * Scope guard: a key scoped to some names (policies/indexes/environments/...) may not touch
   * others; `null` scopes means "every scope." Generalizes ratelimit's `assertPolicy`.
   * @param {ApiKey} key
   * @param {string} name
   * @param {(name: string) => Error} makeError
   */
  static assertScope(key, name, makeError) {
    if (key.scopes && !key.scopes.includes(name)) throw makeError(name);
  }

  /**
   * Constant-time comparison independent of input length.
   * @param {string} a
   * @param {string} b
   */
  static #secretsEqual(a, b) {
    return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
  }
}
