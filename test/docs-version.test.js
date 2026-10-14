import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(import.meta.dirname, '..');
const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

test('install examples pin the current release tag', () => {
  for (const file of ['README.md', 'VERSIONING.md']) {
    const tags = [...readFileSync(join(ROOT, file), 'utf8').matchAll(/#v(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
    assert.ok(tags.length > 0, `${file} shows an install tag`);
    assert.deepEqual([...new Set(tags)], [version], `${file} must pin #v${version}`);
  }
});
