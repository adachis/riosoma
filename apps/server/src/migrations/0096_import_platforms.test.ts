import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { MIGRATIONS } from './index.js';

it('keeps one shared platform check for every import unit', () => {
  // Later migrations follow this one, so find it by id rather than by position.
  const migration = MIGRATIONS.find((candidate) => candidate.id === '0096_import_platforms')!;
  expect(migration).toBeDefined();
  expect(
    MIGRATIONS.filter((candidate) => candidate.sql.includes('platform_imports_platform_check')),
  ).toHaveLength(
    MIGRATIONS.filter(
      (candidate) => candidate.sql.includes('platform_imports_platform_check') && candidate.id < '0097',
    ).length,
  );
  expect(migration.sql).toContain(
    "CHECK (platform IN ('nocodb', 'baserow', 'grist', 'teable', 'seatable', 'clickup', 'asana', 'notion', 'monday', 'smartsheet'))",
  );
  expect(readFileSync(new URL('./index.ts', import.meta.url), 'utf8')).toContain(
    "import { m0096 } from './0096_import_platforms.js'",
  );
  expect(migration.sql).not.toMatch(/SET\s+(NULL|DEFAULT)\s*\(|NULLS\s+NOT\s+DISTINCT|\bMERGE\s+INTO\b/i);
});
