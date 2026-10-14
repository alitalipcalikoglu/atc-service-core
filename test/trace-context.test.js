import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TraceContext } from '../src/trace-context.js';

const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;

/**
 * Post-production Phase 5. This mirrors `atc-gateway/test/trace-context.test.js` field for field — the
 * two `TraceContext` implementations are meant to behave identically (gateway is the source of
 * convention, has no `@atc-web/atc-service-core` dependency to share code with) — plus the full
 * regression matrix item 15 of the phase spec calls for explicitly (malformed separators, non-hex,
 * malformed flags, missing header), some of which gateway's own suite already covers implicitly
 * via its "wrong shape" case but not by name.
 */
test('TraceContext.parse: regression matrix — valid, and every named malformed shape, never throws', () => {
  const good = TraceContext.parse('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
  assert.deepEqual([good?.traceId, good?.spanId, good?.flags], ['4bf92f3577b34da6a3ce929d0e0e4736', '00f067aa0ba902b7', '01'], 'valid lowercase');

  assert.equal(TraceContext.parse(undefined), null, 'missing header');
  assert.equal(TraceContext.parse(null), null, 'missing header (null)');
  assert.equal(TraceContext.parse(''), null, 'missing header (empty string)');
  assert.equal(TraceContext.parse('00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01'), null, 'uppercase hex rejected — matches gateway\'s lower-case-only convention');
  assert.equal(TraceContext.parse('00-4bf92f3577b34da6a3ce929d0e0e473-00f067aa0ba902b7-01'), null, 'malformed length: trace-id one char short');
  assert.equal(TraceContext.parse('00-4bf92f3577b34da6a3ce929d0e0e47366-00f067aa0ba902b7-01'), null, 'malformed length: trace-id one char long');
  assert.equal(TraceContext.parse('00_4bf92f3577b34da6a3ce929d0e0e4736_00f067aa0ba902b7_01'), null, 'malformed separators: underscore instead of hyphen');
  assert.equal(TraceContext.parse('00-4bf92f3577b34da6a3ce929d0e0e4736:00f067aa0ba902b7-01'), null, 'malformed separators: mixed');
  assert.equal(TraceContext.parse('00-4bg92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'), null, 'non-hex: trace-id contains "g"');
  assert.equal(TraceContext.parse('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067zz0ba902b7-01'), null, 'non-hex: span-id contains "z"');
  assert.equal(TraceContext.parse('00-00000000000000000000000000000000-00f067aa0ba902b7-01'), null, 'all-zero trace-id (reserved)');
  assert.equal(TraceContext.parse('00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01'), null, 'all-zero span-id (reserved)');
  assert.equal(TraceContext.parse('01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'), null, 'unsupported version');
  assert.equal(TraceContext.parse('ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'), null, 'unsupported version (ff, the spec\'s own reserved invalid marker)');
  assert.equal(TraceContext.parse('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-1'), null, 'malformed flags: one char short');
  assert.equal(TraceContext.parse('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-gg'), null, 'malformed flags: non-hex');
  assert.equal(TraceContext.parse('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra'), null, 'trailing junk');
  assert.equal(TraceContext.parse(42), null, 'non-string input never throws');
  assert.equal(TraceContext.parse({}), null, 'non-string input never throws (object)');
  assert.notEqual(TraceContext.parse('  00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01  '), null, 'surrounding whitespace is trimmed before matching');
});

test('TraceContext.forRequest: honours a valid header only when trusted; always mints a fresh span id; tracks parentSpanId', () => {
  const inbound = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
  const trusted = TraceContext.forRequest(inbound, true);
  assert.equal(trusted.traceId, '4bf92f3577b34da6a3ce929d0e0e4736', 'trace-id continues the caller\'s trace');
  assert.notEqual(trusted.spanId, '00f067aa0ba902b7', 'a new span id is minted for this hop, never the caller\'s');
  assert.match(trusted.spanId, HEX16);
  assert.equal(trusted.parentSpanId, '00f067aa0ba902b7', 'the inbound span id becomes this hop\'s parentSpanId');

  const untrusted = TraceContext.forRequest(inbound, false);
  assert.notEqual(untrusted.traceId, '4bf92f3577b34da6a3ce929d0e0e4736', 'an untrusted caller cannot inject a trace-id');
  assert.match(untrusted.traceId, HEX32);
  assert.equal(untrusted.parentSpanId, null, 'untrusted: no parent, this is a fresh trace root');

  const noHeader = TraceContext.forRequest(undefined, true);
  assert.match(noHeader.traceId, HEX32);
  assert.match(noHeader.spanId, HEX16);
  assert.equal(noHeader.flags, '01');
  assert.equal(noHeader.parentSpanId, null);

  const malformedWhileTrusted = TraceContext.forRequest('garbage', true);
  assert.match(malformedWhileTrusted.traceId, HEX32);
  assert.equal(malformedWhileTrusted.parentSpanId, null, 'malformed-while-trusted still starts a fresh trace root, never throws');

  // Two independent calls never collide.
  const a = TraceContext.forRequest(undefined, false);
  const b = TraceContext.forRequest(undefined, false);
  assert.notEqual(a.traceId, b.traceId);
  assert.notEqual(a.spanId, b.spanId);
});

test('TraceContext#span: fresh child span, same trace, parentSpanId is the caller\'s own span', () => {
  const root = new TraceContext('a'.repeat(32), 'b'.repeat(16), '01', null);
  const child = root.span();
  assert.equal(child.traceId, root.traceId);
  assert.notEqual(child.spanId, root.spanId);
  assert.match(child.spanId, HEX16);
  assert.equal(child.parentSpanId, root.spanId);
  assert.equal(child.flags, root.flags);
});

test('TraceContext#toString formats as version-traceId-spanId-flags', () => {
  const t = new TraceContext('4bf92f3577b34da6a3ce929d0e0e4736', '00f067aa0ba902b7', '01');
  assert.equal(t.toString(), '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
  assert.equal(new TraceContext('a'.repeat(32), 'b'.repeat(16)).toString(), `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`, 'flags default to 01 (sampled)');
});
