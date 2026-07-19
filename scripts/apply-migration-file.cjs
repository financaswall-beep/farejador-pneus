'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { auditMigrationManifest } = require('./check-migrations.cjs');

const migrationPath = process.argv[2];
const commit = process.argv.includes('--commit');

if (!migrationPath) {
  console.error('Uso: node --env-file=.env scripts/apply-migration-file.cjs db/migrations/NNNN.sql [--commit]');
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL ausente.');
  process.exit(1);
}

async function main() {
  const resolved = path.resolve(migrationPath);
  const root = path.resolve(__dirname, '..');
  const migrationsDir = path.join(root, 'db', 'migrations');
  const relative = path.relative(migrationsDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative) || path.dirname(relative) !== '.') {
    throw new Error('apenas arquivos versionados diretamente em db/migrations podem ser aplicados');
  }
  const audit = auditMigrationManifest(root);
  if (!audit.ok) throw new Error(`manifesto de migrations invalido: ${audit.errors.join('; ')}`);
  const sql = fs.readFileSync(resolved, 'utf8');
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  console.log(`Aplicando ${path.basename(migrationPath)} (${commit ? 'COMMIT' : 'DRY-RUN'})`);

  await client.query('BEGIN');
  try {
    await client.query(sql);
    if (commit) {
      await client.query('COMMIT');
      console.log('OK: commit efetuado.');
    } else {
      await client.query('ROLLBACK');
      console.log('OK: dry-run concluido com rollback.');
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error(`ERRO: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`ERRO: ${err.message}`);
  process.exit(1);
});
