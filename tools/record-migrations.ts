import { readFileSync, writeFileSync } from 'node:fs';
import { addMigrationChecksums, type MigrationChecksum } from '../apps/server/src/migrations/checksum-record.js';
import { MIGRATIONS } from '../apps/server/src/migrations/index.js';

const record = new URL('../apps/server/src/migrations/checksums.json', import.meta.url);
const recorded = JSON.parse(readFileSync(record, 'utf8')) as MigrationChecksum[];
const next = addMigrationChecksums(MIGRATIONS, recorded);
writeFileSync(record, `${JSON.stringify(next, null, 2)}\n`);
