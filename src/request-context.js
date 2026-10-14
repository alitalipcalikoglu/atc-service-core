import { AsyncLocalStorage } from 'node:async_hooks';
import { TraceContext } from './trace-context.js';

const als = new AsyncLocalStorage();

/**
 * Per-request correlation state (`requestId` + a {@link TraceContext}), carried through a
 * request's whole async lifecycle via `node:async_hooks`'s `AsyncLocalStorage` — never a global
 * mutable variable, so two concurrent requests never see each other's values regardless of how
 * their async work interleaves. Set up once per request by `registerRequestContext`
 * (`fastify-helpers.js`); read anywhere downstream with {@link RequestContext.get}.
 *
 * **Trace identifiers are correlation metadata, not authentication or authorization identities.**
 * Nothing in this class, or anywhere this class's value is read, may be used to make a security,
 * rate-limit, or tenant decision — see `atc-stack/docs/OBSERVABILITY.md`'s "Trust model" for the full
 * statement this codebase holds to.
 */
export class RequestContext {
  /**
   * @param {object} o
   * @param {string} o.requestId
   * @param {TraceContext} o.trace
   */
  constructor({ requestId, trace }) {
    this.requestId = requestId;
    this.trace = trace;
  }

  get traceId() { return this.trace.traceId; }
  get spanId() { return this.trace.spanId; }
  get parentSpanId() { return this.trace.parentSpanId; }

  /**
   * Explicit, opt-in headers for an outbound call to a TRUSTED INTERNAL platform dependency only
   * (a fixed atc-web service this process calls directly, e.g. auth's own call to notify) — never
   * for an operator-configured or otherwise external target (a scheduler job URL, a webhook-out
   * subscriber, notify's webhook channel, audit's anchor webhook). There is no automatic/implicit
   * propagation anywhere in this package; a caller must import this class and call this method by
   * name at each internal call site that wants it.
   * @returns {{ 'x-request-id': string, traceparent: string }}
   */
  propagationHeaders() {
    return { 'x-request-id': this.requestId, traceparent: this.trace.span().toString() };
  }

  /**
   * Runs `fn` with `context` as the active request context for its entire (possibly async) call
   * tree. Prefer this in tests and any call site that already has a natural "the rest of this unit
   * of work" callback; the Fastify integration itself uses `enterWith` instead (see
   * `registerRequestContext`), since a `beforeHandler`-style hook has no such callback to wrap.
   * @template T
   * @param {RequestContext} context @param {() => T} fn
   * @returns {T}
   */
  static run(context, fn) {
    return als.run(context, fn);
  }

  /** Sets `context` as active for the remainder of the current execution and everything async that continues from it — see {@link run}'s doc for when to prefer which. @param {RequestContext} context */
  static enterWith(context) {
    als.enterWith(context);
  }

  /** The active request context, or `null` outside any request (a background job, a startup task, a test that never called {@link run}/{@link enterWith}). */
  static get() {
    return als.getStore() ?? null;
  }
}
