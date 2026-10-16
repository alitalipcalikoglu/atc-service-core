# atc-service-core

Shared cross-cutting infrastructure for the [atc-web](https://github.com/alitalipcalikoglu?tab=repositories) services: config parsing, a SQLite base class, audit-event forwarding, API-key auth, an outbound SSRF guard/signer/HTTP transport, graceful process shutdown, and small Fastify helpers. No domain logic, no service orchestration, no app factory — every service still owns its own `Fastify(...)` instance, schema, and business rules.

## Why this exists

Every atc-web service is its own independent repository (`atc-web/<name>/`, copy the folder, `npm ci`, run). That independence is deliberate, but it meant roughly 450 lines of identical or near-identical infrastructure code were copied into each one — a change to the audit-retry policy needed a commit in 11 repositories. This package extracts exactly the parts that really are identical or safely parameterizable, and leaves everything with real per-service behavior (differing key formats, differing shutdown order, differing signing schemes) where it was. Adopted by all 12 stateful services (ratelimit, geo, search, flags, shortlink, audit, media, notify, scheduler, webhook-out, auth, console). See each source repository's `docs/READINESS.md` for what that service specifically adopted, and its own commit message for the exact compatibility decisions made.

## Boundaries

**Purpose:** shared, generic cross-cutting infrastructure — config parsing, a SQLite base class with migration/backup mechanics, audit-forwarding client, API-key auth, outbound HTTP guard/signing, process lifecycle, Fastify helpers, `/v1/info` registration.

**Responsibilities:** everything above, as composable classes/functions a service imports and wires itself.

**Non-responsibilities:** atc-service-core ≠ domain framework — no service-specific table names, route names, or business rules live here, and it defines no app factory a service inherits its whole shape from; each service still builds its own `Fastify(...)` instance, schema and domain logic. See "What deliberately stayed local" below for concrete examples of things that look shareable but were deliberately kept out.

## Install

Not published to any registry — installed straight from GitHub, pinned to a tag:

```
npm install github:alitalipcalikoglu/atc-service-core#v1.31.0
```

A service's `package.json` then has `"@atc-web/atc-service-core": "github:alitalipcalikoglu/atc-service-core#v1.31.0"`, and `npm ci` resolves and clones that exact tagged commit — no private registry, no simultaneous-upgrade requirement across services. Every consuming service pins its own tag independently; see [VERSIONING.md](VERSIONING.md).

## Modules

Each is a separate `exports` subpath so a service only pulls in what it uses. "Adopters" counts real, current importers, not services that merely *could* use it.

| Import | Contents | Adopters |
|---|---|---|
| `@atc-web/atc-service-core/config` | `EnvReader`, `ConfigError`, `parseApiKeys`, `parseAudit`, `parseTarget` | every service |
| `@atc-web/atc-service-core/db` | `Database` (subclass with your own `static MIGRATIONS`; ordered, transactional, tracked in `schema_migrations`, pre-migration snapshot, forward-version guard, `inTransaction` — see below) | every service |
| `@atc-web/atc-service-core/audit` | `AuditClient` — buffered/batched mode (fail-safe forwarding to the audit service) for most services, or outbox mode (`{ outbox }`) for a service with a durability requirement on the event itself — see below | every backend service (not audit itself) |
| `@atc-web/atc-service-core/auth` | `ApiKeyAuth` (bearer key auth; decoration shape and role rules are options; optional key expiry `…@YYYY-MM-DD`, last-use tracking, `describe()` and `metricLines()` without secrets) | every backend service (not console — session+TOTP admin auth, no API keys) |
| `@atc-web/atc-service-core/lifecycle` | `Lifecycle.install(...)` — signal handling, ordered shutdown steps, force-exit | every service |
| `@atc-web/atc-service-core/fastify` | `jsonParser`, `createErrorHandler`, `registerProbes`, `metricsText`, `registerInfo`/`readServiceVersion`/`SERVICE_CORE_VERSION` (Stage 7: `/v1/info`); `requestOptions`/`registerRequestContext` (Phase 5: the shared `requestIdHeader`/`genReqId`/logger block, and the per-request `RequestContext` + trace-aware log binding) | every service (including console, via `registerInfo` directly — see below) |
| `@atc-web/atc-service-core/http` | `HttpCaller`, `CallError`, `NetGuard`, `NetGuardError`, `Signer` | 2 services (scheduler, webhook-out — the only two services that make caller-supplied outbound HTTP calls) |
| `@atc-web/atc-service-core/secrets` | `SecretBox` — AES-256-GCM sealing of a small secret at rest, versioned format (`v1.` single-key; `v2.` embeds a `keyId` for a caller managing more than one key — e.g. rotation), key supplied by the caller (never stored in the database) | 2 services (webhook-out on `v1.`, console on `v2.` — its own `TotpKeyring` builds the current/previous rotation logic on top; this stays a single-key primitive) |
| `@atc-web/atc-service-core/trace` | `TraceContext` — W3C `traceparent` subset parse/generate, mirroring `atc-gateway/src/trace-context.js`'s convention exactly (source of truth; gateway itself has no dependency on this package) | every backend service (every backend consumer; not console, which imports it indirectly via `./request-context`) |
| `@atc-web/atc-service-core/request-context` | `RequestContext` — `AsyncLocalStorage`-based per-request correlation state (`requestId` + `TraceContext`), explicit opt-in `propagationHeaders()` for a trusted-internal outbound call | every service |
| `@atc-web/atc-service-core/idempotency` | `Idempotency` — `Idempotency-Key` for POST writes: first 2xx JSON answer stored per API key for 24 h in the service's own SQLite (`service_idempotency`), repeats replayed with `Idempotent-Replayed: true`, `409 IDEMPOTENCY_MISMATCH` / `IDEMPOTENCY_IN_PROGRESS`; opt-in per route with `config.idempotent: true` (never on routes that answer with secrets); scoped per API key plus caller identity (`X-Actor`, hashed end-user token); `AuditClient.hook` skips replays | every backend service with POST writes |
| `@atc-web/atc-service-core/ids` | `Ids` — the one generated id format `<prefix>_<base36 ms><16 hex>` (`Ids.create`, `Ids.pattern`, `Ids.is`) | every backend service that generates resource ids |

Every module's own JSDoc explains the exact contract and which per-service behavior stays local (e.g. `ApiKeyAuth`'s `decorate` option, `Lifecycle`'s caller-supplied `steps` order, `createErrorHandler`'s `extra` hook).

## Migration standard

`Database` applies `static MIGRATIONS` in order, one `BEGIN`/`COMMIT` transaction per version. A fresh file and an existing one being upgraded run through the exact same loop, starting from whatever `PRAGMA user_version` already is (0 for a new file). Every applied migration is also recorded in `schema_migrations(version, name, applied_at, duration_ms)` — `version` is the primary key, so applying the same migration twice is a constraint violation, not a silent no-op. A migration that throws rolls back just that one transaction; `user_version` stays at the last successful version and the error propagates, so the service fails to start rather than run on a half-migrated schema.

Before the first pending migration on a database that already has data (`user_version > 0`), the file is snapshotted with `VACUUM INTO` to `<path>.pre-v<current>-<timestamp>` next to the database file (override the directory with the constructor's `backupDir` option) — skipped for `:memory:` and for a brand new file, since there is nothing to protect yet. `VACUUM INTO` takes its own consistent read snapshot, so this is safe to run against a live WAL database with concurrent readers. If a database's `user_version` is ahead of what the running build's `MIGRATIONS` array supports, the constructor throws `ConfigError` before touching anything — an old build refuses to open a newer schema.

`db.schemaVersion` exposes the current version (for `/v1/info`); `db.lastBackupPath` is the snapshot path from the open that just ran, or `null` when none was taken; `db.inTransaction` is true while a `transaction()` callback is running — check it before calling `transaction()` again on the same connection (SQLite has no nested transactions), the pattern an outbox-style insert needs to work correctly whether or not the caller already has one open (see `@atc-web/atc-service-core/audit`'s outbox mode below).

See `atc-stack/docs/UPGRADE.md` for how this fits together with `stack backup`/`stack restore` across the whole workspace.

## AuditClient outbox mode

Buffered mode (the default) loses an event that was `record()`-ed but not yet flushed if the process crashes — fine for most audit events, which describe something that already happened and are best-effort by nature. A service with an event whose *own* durability matters (Stage 4: `atc-auth`, where a security event must survive a crash between the business mutation that caused it and the network call that reports it) passes `{ outbox: OutboxSource }` instead: the service inserts the event into its own table itself, in the same `db.transaction()` as the mutation the event describes, and this client's timer drains that table instead of an in-memory buffer. `record()` throws in this mode — inserting is deliberately the caller's job, since it has to happen inside a transaction this client has no way to join. See the `OutboxSource` JSDoc typedef in `src/audit-client.js` for the exact three-method interface (`pending`, `markSent`, optional `purge`), and `atc-auth`'s Stage 4 commit for the SQLite side of it (`outbox` table, `EventStore.record` inserting into it via `db.inTransaction`).

Delivery is at-least-once either way (buffered or outbox): a crash between a successful send and this client noting that down (clearing the buffer / calling `markSent`) resends on the next flush. The audit service's own `UNIQUE(source, client_id)` on the posted event's `id` is what makes a resend safe — the same stable `id` is sent every attempt, so a duplicate delivery becomes a no-op on the receiving end instead of a duplicate record.

### Removed before Stage 2 closed: zero-adopter modules

Two modules were built and shipped mid-stage on the assumption a real consumer would land, then removed once Stage 2's actual adoption order made clear neither one would:

- **`context` (`TraceContext`)** — moved here from gateway's own `trace-context.js` early in Stage 2. But gateway itself was never in Stage 2's adoption order (it's stateless, no config/db/audit/lifecycle module applies to it the same way), and no other service did `traceparent` handling at the time. Zero real adopters; removed rather than shipped as a speculative export. Gateway kept its own original file, unchanged, throughout. **Re-added in post-production Phase 5** as `./trace` + `./request-context`, this time with concrete adopters (all 11 backend Fastify consumers plus console) driven by a real audit finding, not a repeat of the same speculative bet — gateway still has no dependency on this package and still keeps its own, independent, behaviourally-identical copy.
- **`db`'s `StatementCache`** — a generalization of the ad hoc `Map`-based statement-caching idiom a couple of stores used. Every actual store, audit's `EventStore` included, kept its own existing pattern rather than adopting it (see audit's Stage 2 commit) — the shapes didn't match closely enough to be worth forcing. Zero real adopters; removed. The one genuinely load-bearing lesson from that idiom (never cache a statement used with `.iterate()`) is kept as a doc comment on `Database` instead of a class nobody used.

## What deliberately stayed local

Not everything that looks similar across services moved here:

- **notify's outbound webhook signing** (`channels/webhook.js`) was not migrated to this package's `Signer`/`HttpCaller`. Its signature verification uses `Buffer.prototype.equals` instead of a timing-safe comparison — a known, already-tracked defect scheduled for its own fix in a later stage. Adopting core's (correct) `Signer` would have silently changed that behavior as a side effect of an "extraction" stage.
- **auth's error handler and JWT/password/session logic** — the login-lockout `retry-after` header lives inside the same branch `createErrorHandler` would dispatch on, not a separately classed case its `extra` hook cleanly covers; forcing that shape would touch security-relevant response behavior. All of JWT signing, password hashing and session/token stores were never candidates — this package has no such modules and none of it is cross-cutting.
- **console's readiness and error handling** — console's `/ready` checks live on every call with no cache window (every other service caches for 10–30s); its error handler dispatches on two domain classes with a `service` field on one of them. Genuinely different shapes, left local rather than forced.
- **scheduler's and webhook-out's domain delivery logic** — only the pinned-socket transport (`HttpCaller.send()`) and the SSRF guard (`NetGuard`) are shared. Arbitrary HTTP method and bearer-token-by-name lookup (scheduler), always-POST multi-secret signing and `x-webhook-*` headers (webhook-out), and each service's own retry/backoff policy stay in that service's own (now thinner) `net/http-caller.js`.
- **`crypto/password.js`, `crypto/opaque-token.js`** (auth ↔ console), **`rate-limiter.js`** (gateway ↔ console) and **`maintenance.js`** (auth/console/flags/shortlink/media/audit) are duplicated but were not pulled into this package — each is domain-adjacent enough (password hashing policy, a specific rate-limit algorithm, per-service maintenance windows) that centralizing it risked exactly the "giant framework" this package is meant not to become. They remain candidates for a future, separately-scoped extraction, not attempted here.

## License

MIT, see [LICENSE](LICENSE).
