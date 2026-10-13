import { basename, dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ConfigError } from './config.js';

const MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    applied_at  INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL
  )
`;

/**
 * SQLite connection with schema migrations applied on open. Every service subclasses this with its
 * own `static MIGRATIONS` (an ordered array of SQL blocks, one per schema version) — nothing else
 * changes, so an existing service's schema and migration content move here unmodified:
 *
 * ```js
 * import { Database as CoreDatabase } from '@atc-web/atc-service-core/db';
 * export class Database extends CoreDatabase {
 *   static MIGRATIONS = [`CREATE TABLE ...`];
 * }
 * ```
 *
 * `#migrate()` reads `MIGRATIONS` off the actual subclass (`this.constructor.MIGRATIONS`), so a
 * service that defines no migrations at all (there is none today, but the base class must not
 * assume one exists) simply gets an empty array via the default below. A fresh database (no prior
 * `user_version`) and an existing one being upgraded run through this exact same loop — there is no
 * separate "create" path.
 *
 * Migration tracking is deterministic and layered two ways: `PRAGMA user_version` is the fast-path
 * check (unchanged from before), and every applied migration also gets a row in `schema_migrations`
 * (`version INTEGER PRIMARY KEY`, so a second attempt to record the same version is a constraint
 * violation, not silent). Each migration runs in its own `BEGIN IMMEDIATE`/`COMMIT`; a failure rolls
 * back that one migration and throws, leaving `user_version` at the last successfully applied
 * version — the service then fails to start rather than run against a half-migrated schema. Before
 * the first pending migration on a database that already has data (`user_version > 0`), the file is
 * snapshotted with `VACUUM INTO` to `<path>.pre-v<current>-<timestamp>-<pid>` (skipped for
 * `:memory:` and for a brand new database, since there is nothing to protect yet) — `VACUUM INTO`
 * takes its own consistent read snapshot, so it is safe under WAL with concurrent readers. If the
 * database's `user_version` is already ahead of what this build's `MIGRATIONS` supports, the
 * constructor throws `ConfigError` instead of touching anything — an old build must never run
 * against a newer schema.
 *
 * **Concurrent startup migration safety** (post-production Phase 1): two separate OS processes
 * (e.g. a split `<service>-api` + `<service>-worker` pair's simultaneous first start — see
 * `stack up --split-workers`) opening the SAME database file at the same instant, against a pending
 * migration, do not race the migration SQL itself. `#migrate()` acquires SQLite's write lock with
 * `BEGIN IMMEDIATE` — not a deferred `BEGIN` — before deciding whether a given version still needs
 * applying, and re-reads `PRAGMA user_version` fresh *after* the lock is held, not from a value
 * cached before any lock was acquired. A process that loses the race for a given version's lock
 * blocks until the winner's transaction commits, then discovers on its own fresh read that the
 * version it was about to apply is already there, and moves on without re-running that migration's
 * SQL. This makes the migration SQL's logical effect apply exactly once per version regardless of
 * how many processes raced to open the file, and the loser never crashes on a genuinely simultaneous
 * start. `VACUUM INTO` itself cannot run inside a transaction (verified empirically against
 * `node:sqlite`), so the pre-migration backup is *not* lock-serialized the way migration application
 * is — under a real race, more than one process may each take a (redundant but harmless, since
 * neither has migrated anything yet at that point) backup; every backup taken is always valid and
 * always represents the state strictly before any migration SQL in this open. See
 * `stack/docs/POST_PRODUCTION_PLAN.md` Phase 1 and `test/migration-race.test.js` for the full
 * reasoning and the real cross-process regression this guarantees.
 *
 * This guarantee is specifically about *this database file's own local startup migration*, opened
 * by processes on the *same host* through `node:sqlite`. It says nothing about network filesystems,
 * distributed databases, or normal (post-startup) multi-process runtime access beyond what each
 * service's own lease/heartbeat model already provides — see the "Compatibility/performance" note in
 * the Phase 1 report for the exact boundary of what changed.
 *
 * This class does not cache prepared statements — every service already had its own idiom for that
 * (either a fixed set of named statements prepared once, or an ad hoc `Map` for dynamic SQL) and
 * none of them turned out to share the same shape closely enough to be worth a generic cache class
 * here. One gotcha worth keeping regardless of who does the caching: never reuse a cached statement
 * for `.iterate()` — `StatementSync#iterate()` keeps cursor state on the statement object itself, so
 * two concurrent `.iterate()` calls sharing one cached statement reset each other's cursor (the bug
 * Stage 0 fixed in audit's `EventStore.iterate()`). Prepare a fresh statement per `.iterate()` call.
 */
export class Database {
  /** @type {readonly string[]} */
  static MIGRATIONS = [];

  /**
   * @param {string} path File path, or ":memory:".
   * @param {{ backupDir?: string }} [opts] `backupDir` overrides where the pre-migration snapshot is
   *   written; defaults to the database file's own directory.
   */
  constructor(path, opts = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    /** @readonly */
    this.path = path;
    /** @readonly */
    this.raw = Database.#openWithRetry(path);
    /** Path of the pre-migration snapshot taken during this open, if any. @type {string|null} */
    this.lastBackupPath = null;
    this.#migrate(opts.backupDir);
  }

  /**
   * Two processes racing to open the SAME genuinely nonexistent database file at the same instant
   * (a fresh-database concurrent-creation race — distinct from, and earlier than, the pending-
   * migration race `#migrate()` guards against) can hit `SQLITE_LOCKED`/"database is locked" on
   * `PRAGMA journal_mode = WAL` itself, before `busy_timeout` has even been set — confirmed
   * empirically, and confirmed that `busy_timeout` would not have covered it anyway (it retries
   * `SQLITE_BUSY`, not `SQLITE_LOCKED`; verified: `SQLITE_LOCKED` is a schema/table lock conflict
   * between two connections, not the "another connection is mid-write" condition `busy_timeout`
   * addresses). Also confirmed empirically that `journal_mode = WAL` cannot be changed inside a
   * transaction — SQLite silently leaves the mode unchanged rather than erroring, so wrapping this
   * in `BEGIN IMMEDIATE` the way `#migrate()`'s own race is guarded would silently fail to take
   * effect, not just be the wrong tool. A short, bounded, jittered retry on this specific,
   * well-understood, transient condition is the minimal fix: creating a brand-new SQLite file's
   * WAL/SHM sidecars is fast, so the losing process's wait is on the order of milliseconds, not the
   * multi-second timeouts `busy_timeout` is sized for.
   * @param {string} path
   */
  static #openWithRetry(path) {
    const MAX_ATTEMPTS = 20;
    for (let attempt = 1; ; attempt++) {
      try {
        const raw = new DatabaseSync(path);
        raw.exec('PRAGMA journal_mode = WAL');
        raw.exec('PRAGMA synchronous = NORMAL');
        raw.exec('PRAGMA busy_timeout = 5000');
        raw.exec('PRAGMA foreign_keys = ON');
        return raw;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (attempt >= MAX_ATTEMPTS || !/database is locked/i.test(message)) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 + Math.floor(Math.random() * 15));
      }
    }
  }

  /** Current `PRAGMA user_version` — the applied schema version. */
  get schemaVersion() {
    return /** @type {{ user_version: number }} */ (this.raw.prepare('PRAGMA user_version').get()).user_version;
  }

  /** @param {string|undefined} backupDir */
  #migrate(backupDir) {
    /** @type {readonly string[]} */
    const migrations = /** @type {typeof Database} */ (this.constructor).MIGRATIONS;
    // `CREATE TABLE IF NOT EXISTS` is idempotent, but SQLite's own schema-modification lock (not
    // covered by busy_timeout — confirmed empirically: it throws "database is locked", not the
    // SQLITE_BUSY busy_timeout retries) still means two processes racing this exact statement
    // unguarded can collide. Lock-guard it the same way the migration loop below is guarded, so a
    // genuinely simultaneous first open of a brand new database (nothing to migrate yet, but the
    // table itself still needs creating) is race-safe too.
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      this.raw.exec(MIGRATIONS_TABLE);
      this.raw.exec('COMMIT');
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    }
    const precheck = this.schemaVersion;
    if (precheck > migrations.length) {
      throw new ConfigError(`database is newer than this build supports (schema v${precheck}, build supports up to v${migrations.length}); refusing to open ${this.path}`);
    }
    if (precheck === migrations.length) return; // nothing pending: no lock needed, matches every normal open of an already-current database
    this.#backup(precheck, backupDir);
    // From here on, a concurrent process opening this same file (e.g. a split api/worker pair's
    // simultaneous first start) may be racing this exact migration. Each iteration acquires
    // SQLite's write lock with BEGIN IMMEDIATE before deciding anything, then re-reads
    // user_version fresh — a process that loses a given version's race simply discovers, once it
    // finally gets the lock, that the version it was about to apply is already there, and returns
    // without re-running that migration's SQL.
    for (;;) {
      this.raw.exec('BEGIN IMMEDIATE');
      const v = this.schemaVersion;
      if (v > migrations.length) {
        this.raw.exec('ROLLBACK');
        throw new ConfigError(`database is newer than this build supports (schema v${v}, build supports up to v${migrations.length}); refusing to open ${this.path}`);
      }
      if (v === migrations.length) {
        this.raw.exec('ROLLBACK'); // nothing written; a concurrent process already finished this transition
        return;
      }
      try {
        const startedAt = Date.now();
        this.raw.exec(migrations[v]);
        this.raw.exec(`PRAGMA user_version = ${v + 1}`);
        this.raw.prepare('INSERT INTO schema_migrations (version, name, applied_at, duration_ms) VALUES (?, ?, ?, ?)').run(v + 1, `v${v + 1}`, Date.now(), Date.now() - startedAt);
        this.raw.exec('COMMIT');
      } catch (err) {
        this.raw.exec('ROLLBACK');
        throw err;
      }
    }
  }

  /**
   * Snapshot the file before the first pending migration touches it. No-op for `:memory:` or a
   * brand new database (`currentVersion === 0`): there is no existing data to protect. Called once
   * per `#migrate()` call, before any locking — `VACUUM INTO` cannot run inside a transaction
   * (verified against `node:sqlite`: "cannot VACUUM from within a transaction"), so this step is not
   * itself serialized against a concurrent process also taking a backup for the same transition; the
   * destination filename includes this process's own pid specifically so two such concurrent
   * backups can never collide on the same path (each always succeeds, writing its own file), rather
   * than one of them failing with "output file already exists".
   * @param {number} currentVersion
   * @param {string|undefined} backupDir
   */
  #backup(currentVersion, backupDir) {
    if (this.path === ':memory:' || currentVersion === 0) return;
    const dir = backupDir || dirname(this.path);
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, `${basename(this.path)}.pre-v${currentVersion}-${Date.now()}-${process.pid}`);
    this.raw.prepare('VACUUM INTO ?').run(dest);
    this.lastBackupPath = dest;
  }

  /** @param {string} sql */
  prepare(sql) {
    return this.raw.prepare(sql);
  }

  /**
   * Run `fn` inside a write transaction; rolls back on throw. SQLite has no nested transactions —
   * calling this again while already inside one throws rather than silently opening a second
   * `BEGIN`; check {@link inTransaction} first if a method needs to work both standalone and inside
   * a caller's already-open transaction (see `EventStore`-style outbox inserts in `auth`/`console`).
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  transaction(fn) {
    if (this.#inTransaction) throw new Error('Database.transaction: already inside a transaction (no nested transactions); check db.inTransaction first');
    this.raw.exec('BEGIN IMMEDIATE');
    this.#inTransaction = true;
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    } finally {
      this.#inTransaction = false;
    }
  }

  /** True while a {@link transaction} callback is running on this connection. */
  get inTransaction() {
    return this.#inTransaction;
  }

  /** @type {boolean} */
  #inTransaction = false;

  /** Cheap liveness probe; throws if the connection is unusable. */
  ping() {
    this.raw.prepare('SELECT 1').get();
  }

  /** Database file size in bytes. */
  sizeBytes() {
    const r = /** @type {{ bytes: number }} */ (this.raw.prepare('SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()').get());
    return Number(r.bytes);
  }

  close() {
    this.raw.close();
  }
}
