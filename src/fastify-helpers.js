/**
 * Pure Fastify helpers shared by every service that owns an HTTP API — no app factory here (each
 * service still builds its own `Fastify(...)` instance; TLS options and body limits stay
 * per-service config). Post-production Phase 5: the request-id generator, previously called out
 * here as deliberately NOT centralized, now is — see `requestOptions` below. What changed: every
 * one of the 11 adopting services turned out to already share the exact same
 * `requestIdHeader`/`genReqId` behavior (confirmed by re-reading all 11 before touching anything,
 * not assumed), so centralizing it is a real dedup, not a forced one; `trustProxy`, `bodyLimit`,
 * `ajv` and `https` stay per-service, unchanged, for the same reason they always did.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { RequestContext } from './request-context.js';
import { TraceContext } from './trace-context.js';

/**
 * The version of the service-core copy actually installed and running right now — read from this
 * package's own `package.json` at import time, never a string maintained by hand elsewhere. This
 * is what `registerInfo` reports as `serviceCore`, so it can never drift from what is truly
 * running (Stage 7).
 */
export const SERVICE_CORE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/**
 * Reads a service's own `version` out of its `package.json` at the repository root — every
 * service has the identical `src/<file>.js` -> `../package.json` layout, so the caller just
 * passes its own `import.meta.url` (Stage 7: this is what feeds `/v1/info`'s `version` field,
 * instead of a second copy of the version hand-maintained in source).
 * @param {string} importMetaUrl
 * @returns {string}
 */
export function readServiceVersion(importMetaUrl) {
  return JSON.parse(readFileSync(new URL('../package.json', importMetaUrl), 'utf8')).version;
}

/**
 * The exact `requestIdHeader`/`genReqId`/`logger`/`loggerInstance` block every backend Fastify
 * consumer built by hand, confirmed identical (down to the exact `x-request-id` header name and
 * plain `randomUUID()` generator, no validation, no trust gating, no response echo — unchanged
 * from before this existed) across all 11 real adopters before this was written. Spread into the
 * `Fastify({...})` constructor call alongside whatever stays per-service (`trustProxy`,
 * `bodyLimit`, `ajv`, `https`).
 * @param {object} o
 * @param {import('fastify').FastifyBaseLogger|null} [o.logger] `this.logger`, when the caller
 *   already has one (worker role sharing a `ConsoleLogger`); omit/null to build one from `logLevel`.
 * @param {string} [o.logLevel]
 * @param {string[]} [o.extraRedact] Additional `redact` paths beyond the universal
 *   `req.headers.authorization` — e.g. auth's own `req.headers["x-access-token"]`.
 * @returns {{ loggerInstance: import('fastify').FastifyBaseLogger|undefined, logger: object|undefined, requestIdHeader: string, genReqId: () => string }}
 */
export function requestOptions({ logger = null, logLevel = 'info', extraRedact = [] } = {}) {
  return {
    loggerInstance: logger ?? undefined,
    logger: logger ? undefined : { level: logLevel, redact: ['req.headers.authorization', ...extraRedact] },
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
  };
}

/**
 * Post-production Phase 5: establishes the per-request {@link RequestContext} — request id plus a
 * {@link TraceContext} — for every inbound request, and binds `traceId`/`spanId` onto that
 * request's own child logger so they appear on every subsequent `request.log.*` call without
 * touching an individual call site. `enterWith`, not `run`: an `onRequest` hook has no "rest of
 * this unit of work" callback to wrap, only a continuation — the same approach console's own
 * pre-Phase-5 context already used and proved out.
 *
 * `trustProxy` gates whether an inbound `traceparent` is even looked at, reusing the exact trust
 * declaration every one of these services already makes for `X-Forwarded-For` (the same
 * `config.trustProxy` passed to `Fastify({trustProxy: ...})` itself) — not a new trust boundary,
 * and not a cryptographic one: an operator who sets `TRUST_PROXY=true` is already declaring "the
 * immediate hop in front of this process is my own trusted reverse proxy/gateway", which is
 * exactly the condition under which trusting that same hop's `traceparent` is sound. **This value
 * is never consulted for an authentication, authorization, rate-limit or tenant decision** —
 * request-id trust and API-key auth are both completely unaffected by this function.
 *
 * Uses `setChildLoggerFactory`, not an `onRequest` hook that reassigns `request.log` — verified
 * empirically that the latter does NOT work for this: Fastify's own built-in "incoming request"/
 * "request completed" lines are emitted through a logger reference resolved at request-log
 * *creation* time, before any `onRequest` hook runs, so a later reassignment inside a hook is
 * invisible to them (it only reaches log calls a route handler makes itself, afterward).
 * `childLoggerFactory` runs exactly at that creation point instead — its `bindings` argument
 * already carries the real, resolved request id (Fastify's own default factory puts it there
 * first), so every log line for this request, including the automatic ones, carries
 * `traceId`/`spanId` with zero per-call-site changes anywhere.
 * @param {import('fastify').FastifyInstance} app
 * @param {{ trustProxy: boolean }} o
 */
export function registerRequestContext(app, { trustProxy }) {
  app.setChildLoggerFactory(function (logger, bindings, opts, rawReq) {
    const trace = TraceContext.forRequest(rawReq.headers.traceparent, trustProxy);
    RequestContext.enterWith(new RequestContext({ requestId: String(bindings.reqId ?? ''), trace }));
    return logger.child({ ...bindings, traceId: trace.traceId, spanId: trace.spanId }, opts);
  });
}

/**
 * Tolerant `application/json` body parser: an empty body becomes `undefined` instead of a parse
 * error, anything else that fails to parse becomes a 400 `INVALID_JSON` instead of Fastify's
 * default `FST_ERR_CTP_INVALID_MEDIA_TYPE`-flavoured message. Not a fit for a service whose routes
 * need the raw body stream (gateway's proxy, an upload endpoint) — those keep their own parser.
 * @param {import('fastify').FastifyInstance} app
 */
export function jsonParser(app) {
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    if (body === '') return done(null, undefined);
    try {
      done(null, JSON.parse(/** @type {string} */ (body)));
    } catch {
      done(Object.assign(new Error('body is not valid JSON'), { statusCode: 400, code: 'INVALID_JSON' }), undefined);
    }
  });
}

/**
 * Builds a Fastify `setErrorHandler` function. `DomainErrorClass` is the one `instanceof` check
 * every current handler has in common (`RateLimitError`, `LinkError`, `FlagError`, ...) — the
 * class itself stays in the service, only the dispatch shape is shared. `extra`, when given, runs
 * first and may return `true` to mean "handled, do not fall through" — this is how a service's own
 * additional branch (media's 413 on an oversized body, auth's `retry-after` header, shortlink's
 * `QrTooLongError`) survives adoption unchanged instead of being squeezed into core.
 * @param {new (...a: any[]) => { statusCode: number, code: string, message: string, details?: object }} DomainErrorClass
 * @param {{ extra?: (err: any, request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => boolean }} [opts]
 * @returns {import('fastify').FastifyInstance['errorHandler']}
 */
export function createErrorHandler(DomainErrorClass, { extra } = {}) {
  return (rawErr, request, reply) => {
    const err = /** @type {import('fastify').FastifyError & { validation?: { instancePath: string, message?: string, params: object }[] }} */ (rawErr);
    if (extra?.(err, request, reply)) return reply;
    if (err instanceof DomainErrorClass) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
    }
    if (err.validation) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_FAILED', message: err.message, details: err.validation.map((v) => ({ path: v.instancePath, message: v.message, params: v.params })) },
      });
    }
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err }, 'unhandled error');
      return reply.code(status).send({ error: { code: 'INTERNAL_ERROR', message: 'internal error' } });
    }
    return reply.code(status).send({ error: { code: /** @type {any} */ (err).code ?? 'REQUEST_ERROR', message: err.message } });
  };
}

/**
 * Registers `GET /health` (always ok) and `GET /ready` (cached dependency check) exactly as every
 * service does today. `checkReadiness` may be sync or async (notify's checks its SMTP/webhook
 * channels too, not just the DB) and is only re-run after `cacheMs` since the last call.
 * @param {import('fastify').FastifyInstance} app
 * @param {() => (unknown|Promise<unknown>)} checkReadiness Only throwing means unhealthy; any
 *   return value (including `undefined`) means healthy — the return value itself is not inspected.
 * @param {{ cacheMs?: number, extra?: () => Record<string, unknown> }} [opts] `extra`, when given,
 *   is merged into the healthy `/ready` body — scheduler and webhook-out both add a `worker:
 *   'running'|'stopped'` field this way; it is never consulted to decide health, only shown.
 * @returns {{ invalidate: () => void }} `invalidate()` forces the next `/ready` to re-check rather
 *   than serve a cached verdict — geo calls this right after an MMDB reload, so a caller polling
 *   `/ready` learns about a just-failed reload immediately instead of within the cache window.
 */
export function registerProbes(app, checkReadiness, { cacheMs = 10_000, extra } = {}) {
  /** @type {{ at: number, ok: boolean, error: string }} */
  let readyCache = { at: 0, ok: false, error: '' };

  async function readiness() {
    const now = Date.now();
    if (now - readyCache.at > cacheMs) {
      try {
        await checkReadiness();
        readyCache = { at: now, ok: true, error: '' };
      } catch (err) {
        readyCache = { at: now, ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    return readyCache;
  }

  app.get('/health', { logLevel: 'warn' }, async () => ({ status: 'ok' }));
  app.get('/ready', { logLevel: 'warn' }, async (_request, reply) => {
    const ready = await readiness();
    if (!ready.ok) {
      app.log.warn({ error: ready.error }, 'readiness check failed');
      return reply.code(503).send({ status: 'unavailable', error: ready.error });
    }
    return { status: 'ok', ...extra?.() };
  });

  return { invalidate: () => { readyCache = { ...readyCache, at: 0 }; } };
}

/**
 * Registers the public, read-only canonical OpenAPI document for a service. The caller supplies
 * a fixed file URL resolved from its own module, so the path cannot be influenced by a request.
 * Reading at registration time deliberately makes an incomplete runtime package fail during
 * startup instead of exposing a late, ambiguous 500 after the process is already healthy.
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {URL} specUrl Absolute file URL for the repository-root `openapi.yaml`.
 */
export function registerOpenApi(app, specUrl) {
  const document = readFileSync(specUrl);
  app.get('/openapi.yaml', { logLevel: 'warn' }, async (_request, reply) => {
    reply.type('text/yaml; charset=utf-8');
    return reply.send(document);
  });
}

/**
 * Joins Prometheus text-format lines the way every `/metrics` route already does: one string per
 * metric/label combination, newline separated, with a trailing newline.
 * @param {string[]} lines
 */
export function metricsText(lines) {
  return `${lines.join('\n')}\n`;
}

/**
 * Registers `GET /v1/info` (Stage 7): the cross-service contract for identifying a running
 * instance and what it actually, currently supports. Public, unauthenticated, cheap — same
 * pattern as `registerProbes`, meant for `stack status --matrix` and the console's About view as
 * much as for a human hitting the URL.
 *
 * Field semantics (documented once here, not repeated per service — see `atc-stack/docs/API_CONTRACT.md`):
 * - `service`: the manifest id (e.g. `"atc-notify"`), not a display label.
 * - `version`: the service's own package semver — a release number, unrelated to the API contract.
 * - `apiVersion`: the `/v1` HTTP contract version this instance serves. Independent of `version`:
 *   a service can ship many package releases (`1.4.0`, `1.9.0`, ...) while `apiVersion` stays
 *   `"v1"` the whole time, and only changes when the `/v1` contract itself is replaced wholesale.
 * - `capabilities`: real, public, currently-supported behaviors only — deterministic (same input
 *   state -> same list), lowercase, stable identifiers, each documented in the service's README.
 *   Never a planned/future feature.
 * - `schemaVersion`: the stateful service's real, currently-open database schema version (from
 *   `Database#schemaVersion`, i.e. `PRAGMA user_version` — never hand-maintained). `null` for a
 *   service with no database — the one, consistent stateless contract across every such service.
 * - `serviceCore`: `SERVICE_CORE_VERSION` above — the copy of this package actually running,
 *   `null` for a service (gateway) that doesn't depend on service-core at all.
 * @param {import('fastify').FastifyInstance} app
 * @param {{ service: string, version: string, apiVersion?: string, capabilities?: string[], schemaVersion?: number|null }} opts
 */
export function registerInfo(app, { service, version, apiVersion = 'v1', capabilities = [], schemaVersion = null }) {
  app.get('/v1/info', { logLevel: 'warn' }, async () => ({
    service, version, apiVersion, capabilities, schemaVersion, serviceCore: SERVICE_CORE_VERSION,
  }));
}
