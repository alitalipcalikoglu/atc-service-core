#!/usr/bin/env node
// Post-production Phase 1: empirical stress verification, additional to (never a replacement for)
// the deterministic barrier-controlled regression in `test/migration-race.test.js`. Uses plain
// `child_process.spawn` +
// `Promise.all`, real OS processes, no IPC barrier — so its failure rate is directly comparable to
// the audit's own 75-run, ~92%-loser-crash baseline. Not part of `npm test`; run by hand:
//   node --disable-warning=ExperimentalWarning scripts/migration-race-stress.mjs [runs]
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Database } from '../src/db.js';
import { RACE_MIGRATIONS_V1, RACE_MIGRATIONS_V2 } from '../test/fixtures/migration-race-schema.mjs';

const RUNS = Number(process.argv[2] ?? 100);
const here = dirname(fileURLToPath(import.meta.url));
const raceScript = join(here, 'migration-race-stress-child.mjs');

class SeedV1 extends Database {
  static MIGRATIONS = RACE_MIGRATIONS_V1;
}

function spawnOpen(dbPath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', raceScript, dbPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => resolve({ code, out: out.trim() }));
  });
}

let bothSucceeded = 0;
let exactlyOneThrew = 0;
let bothThrew = 0;
let corrupted = 0;
let duplicateMigration = 0;

for (let i = 0; i < RUNS; i++) {
  const dir = mkdtempSync(join(tmpdir(), 'migration-stress-'));
  const dbPath = join(dir, 'app.db');
  new SeedV1(dbPath).close();

  const [a, b] = await Promise.all([spawnOpen(dbPath), spawnOpen(dbPath)]);
  const results = [a, b];
  const oks = results.filter((r) => r.code === 0).length;
  if (oks === 2) bothSucceeded++;
  else if (oks === 1) exactlyOneThrew++;
  else bothThrew++;

  let final;
  try {
    final = new DatabaseSync(dbPath);
    const version = /** @type {any} */ (final.prepare('PRAGMA user_version').get()).user_version;
    const migratedCount = /** @type {any} */ (final.prepare('SELECT migrated_count FROM meta WHERE id = 1').get())?.migrated_count;
    const rows = /** @type {any[]} */ (final.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).map((r) => r.version);
    if (version !== 2 || JSON.stringify(rows) !== JSON.stringify([1, 2])) corrupted++;
    if (migratedCount !== 1) duplicateMigration++;
    final.close();
  } catch {
    corrupted++;
  }

  rmSync(dir, { recursive: true, force: true });
  if ((i + 1) % 10 === 0) process.stderr.write(`.. ${i + 1}/${RUNS}\n`);
}

console.log(JSON.stringify({
  runs: RUNS,
  bothSucceeded,
  exactlyOneThrew,
  bothThrew,
  corrupted,
  duplicateMigration,
  bothSucceededPct: `${((bothSucceeded / RUNS) * 100).toFixed(1)}%`,
  exactlyOneThrewPct: `${((exactlyOneThrew / RUNS) * 100).toFixed(1)}%`,
}, null, 2));
