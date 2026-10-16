import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/**
 * Contract test: every subpath a service will `import` must actually resolve and export the
 * classes/functions the README's module table promises. A
 * package.json `exports` typo or a forgotten export would otherwise only surface as a runtime
 * error in the first *service* that adopts it.
 */
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('package.json declares the exact subpaths this package actually has real adopters for', () => {
  // "./trace" + "./request-context": post-production Phase 5. A prior attempt at this exact idea
  // (TraceContext moved into core during Stage 2) was removed before Stage 2 closed for having
  // zero real adopters — gateway was never in Stage 2's adoption order and no service ended up
  // needing it, so it shipped speculative and was cut. This time it has concrete adopters (all 11
  // backend Fastify consumers plus console), driven by a real audit finding with tested trust
  // semantics, not speculative infrastructure.
  assert.deepEqual(Object.keys(pkg.exports).sort(), ['./audit', './auth', './config', './db', './fastify', './http', './lifecycle', './log', './secrets', './trace', './request-context', './idempotency', './ids'].sort());
});

test('every subpath resolves and exports its documented members', async () => {
  const config = await import('../src/config.js');
  assert.ok(config.EnvReader && config.ConfigError);
  assert.equal(typeof config.parseApiKeys, 'function');
  assert.equal(typeof config.parseAudit, 'function');
  assert.equal(typeof config.parseTarget, 'function');

  const db = await import('../src/db.js');
  assert.ok(db.Database);

  const audit = await import('../src/audit-client.js');
  assert.ok(audit.AuditClient && typeof audit.AuditClient.hook === 'function' && typeof audit.AuditClient.route === 'function');

  const auth = await import('../src/api-key-auth.js');
  assert.ok(auth.ApiKeyAuth && typeof auth.ApiKeyAuth.require === 'function' && typeof auth.ApiKeyAuth.assertScope === 'function');

  const http = await import('../src/http.js');
  assert.ok(http.HttpCaller && http.CallError && http.NetGuard && http.NetGuardError && http.Signer);

  const lifecycle = await import('../src/lifecycle.js');
  assert.ok(lifecycle.Lifecycle && typeof lifecycle.Lifecycle.install === 'function');

  const fastifyHelpers = await import('../src/fastify-helpers.js');
  assert.equal(typeof fastifyHelpers.jsonParser, 'function');
  assert.equal(typeof fastifyHelpers.createErrorHandler, 'function');
  assert.equal(typeof fastifyHelpers.registerProbes, 'function');
  assert.equal(typeof fastifyHelpers.registerOpenApi, 'function');
  assert.equal(typeof fastifyHelpers.metricsText, 'function');
  assert.equal(typeof fastifyHelpers.registerInfo, 'function');
  assert.equal(typeof fastifyHelpers.readServiceVersion, 'function');
  assert.equal(typeof fastifyHelpers.SERVICE_CORE_VERSION, 'string');

  const secrets = await import('../src/secret-box.js');
  assert.ok(secrets.SecretBox && typeof secrets.SecretBox.isSealed === 'function');

  const log = await import('../src/console-logger.js');
  assert.ok(log.ConsoleLogger);

  const trace = await import('../src/trace-context.js');
  assert.ok(trace.TraceContext && typeof trace.TraceContext.parse === 'function' && typeof trace.TraceContext.forRequest === 'function');

  const requestContext = await import('../src/request-context.js');
  assert.ok(requestContext.RequestContext && typeof requestContext.RequestContext.run === 'function' && typeof requestContext.RequestContext.get === 'function');

  assert.equal(typeof fastifyHelpers.requestOptions, 'function');
  assert.equal(typeof fastifyHelpers.registerRequestContext, 'function');
});

test('each exports entry points at a file that exists', () => {
  for (const [subpath, rel] of Object.entries(pkg.exports)) {
    assert.doesNotThrow(() => readFileSync(new URL(`../${rel}`, import.meta.url)), `${subpath} -> ${rel} must exist`);
  }
});
