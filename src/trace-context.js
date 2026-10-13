import { randomBytes } from 'node:crypto';

/**
 * A W3C `traceparent` value: `00-<32 hex trace-id>-<16 hex parent-id>-<2 hex flags>`. This is a
 * subset of the full spec — exactly the fields and validation `gateway/src/trace-context.js`
 * (source of truth: the first, already-tested implementation in this codebase) already enforces,
 * reproduced here rather than reinvented. Not a fit for a `list-format-header` or a future
 * `tracestate` — this codebase has never needed either.
 *
 * Post-production Phase 5: previously removed from this package (see `test/exports.test.js`'s own
 * history note) for having zero real adopters. This time it has concrete ones — every backend
 * Fastify consumer plus console — driven by a real audit finding, not spun up speculatively.
 * `gateway` itself still has no `@atc-web/atc-service-core` dependency (a deliberate, unrelated,
 * standing choice) and keeps its own copy; the two are behaviourally identical by construction; a
 * change to one's validation rules should be mirrored in the other by hand.
 */
export class TraceContext {
  static VERSION = '00';
  static #HEADER_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

  /**
   * @param {string} traceId 32 lower-case hex chars.
   * @param {string} spanId 16 lower-case hex chars — always freshly minted for this hop, never the
   *   inbound value (see {@link forRequest}).
   * @param {string} [flags] 2 lower-case hex chars.
   * @param {string|null} [parentSpanId] The inbound span id this hop's span descends from, when an
   *   accepted inbound traceparent supplied one — `null` for a freshly started trace.
   */
  constructor(traceId, spanId, flags = '01', parentSpanId = null) {
    this.traceId = traceId;
    this.spanId = spanId;
    this.flags = flags;
    this.parentSpanId = parentSpanId;
  }

  /**
   * Parses a raw header value. Rejects (returns `null`, never throws) anything that isn't exactly
   * `00-<32 hex>-<16 hex>-<2 hex>`, lower-case, or whose trace-id or span-id is all-zero (the W3C
   * spec's reserved "absent" value) — matching `gateway/src/trace-context.js#parse` field for
   * field, including the strict version check (only literal `"00"`, not future-proofed) and the
   * lower-case-only requirement (upper-case hex is a well-formed-looking header this deliberately
   * still rejects, same as gateway).
   * @param {unknown} header
   * @returns {{ traceId: string, spanId: string, flags: string }|null}
   */
  static parse(header) {
    if (typeof header !== 'string') return null;
    const m = TraceContext.#HEADER_PATTERN.exec(header.trim());
    if (!m) return null;
    const [, traceId, spanId, flags] = m;
    if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return null;
    return { traceId, spanId, flags };
  }

  /**
   * The context for a newly-arrived request. `trusted` gates whether `header` is even looked at —
   * pass `false` (or omit `header`) and this always starts a brand-new trace, the same as a
   * malformed or missing header would. This is a correlation decision only: whatever `trusted`
   * ends up meaning for a given caller (see `RequestContext`'s own doc and
   * `stack/docs/OBSERVABILITY.md`) must never be confused with, or substituted for, an
   * authentication or authorization decision.
   * @param {unknown} header
   * @param {boolean} trusted
   */
  static forRequest(header, trusted) {
    const parsed = trusted ? TraceContext.parse(header) : null;
    return new TraceContext(
      parsed?.traceId ?? randomBytes(16).toString('hex'),
      randomBytes(8).toString('hex'),
      parsed?.flags ?? '01',
      parsed?.spanId ?? null,
    );
  }

  /** A fresh child span under the same trace — for an outbound call this hop makes. */
  span() {
    return new TraceContext(this.traceId, randomBytes(8).toString('hex'), this.flags, this.spanId);
  }

  toString() {
    return `${TraceContext.VERSION}-${this.traceId}-${this.spanId}-${this.flags}`;
  }
}
