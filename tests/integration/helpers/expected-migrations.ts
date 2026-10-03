import { readFileSync } from 'node:fs';
const files = readFileSync(new URL('../../../db/migrations/manifest.sha256', import.meta.url), 'utf8')
  .split(/\r?\n/).filter(line => /^[a-f0-9]{64}\s+/.test(line)).map(line => line.trim().split(/\s+/)[1]!);
export const expectedMigrationState = {
  version: Number(files.at(-1)!.slice(0, 4)), migration_name: files.at(-1)!,
};
export const expectedMigrationCount = files.length;
