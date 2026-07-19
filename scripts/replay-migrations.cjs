'use strict';

const { readdirSync, readFileSync } = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { auditMigrationManifest, compareMigrations } = require('./check-migrations.cjs');
const {
  patchKnownMigrationIssues,
  stripEmbeddedTransactionControl,
} = require('./migration-compat.cjs');

const root = path.resolve(__dirname, '..');
const migrationsDir = path.join(root, 'db', 'migrations');
const commit = process.argv.includes('--commit');
const bootstrapLocal = process.argv.includes('--bootstrap-local');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL ausente.');
  process.exit(1);
}

function sslConfig() {
  return process.env.DATABASE_SSL === 'false'
    ? false
    : { rejectUnauthorized: false };
}

function assertLocalBootstrapTarget() {
  if (!bootstrapLocal) return;
  const hostname = new URL(process.env.DATABASE_URL).hostname;
  if (!['127.0.0.1', 'localhost', '::1'].includes(hostname)) {
    throw new Error('--bootstrap-local recusado fora de loopback');
  }
}

async function assertFreshTarget(client) {
  const result = await client.query(`
    SELECT EXISTS (
      SELECT 1 FROM pg_namespace
       WHERE nspname = ANY(ARRAY['raw','core','analytics','ops','commerce','agent','network','finance','audit','dashboard'])
    ) OR to_regtype('env_t') IS NOT NULL AS initialized
  `);
  if (result.rows[0]?.initialized) {
    throw new Error('replay_recusado: o banco alvo nao esta vazio');
  }
}

async function bootstrapBarePostgres(client) {
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='farejador_partner_app') THEN
        CREATE ROLE farejador_partner_app LOGIN PASSWORD 'test'
          NOSUPERUSER NOBYPASSRLS NOINHERIT;
      END IF;
    END $$;
  `);
  await client.query('CREATE SCHEMA IF NOT EXISTS cron');
  await client.query(`
    CREATE OR REPLACE FUNCTION cron.schedule(text,text,text)
    RETURNS bigint LANGUAGE sql AS 'SELECT 1::bigint'
  `);
}

async function main() {
  assertLocalBootstrapTarget();
  const audit = auditMigrationManifest(root);
  if (!audit.ok) {
    throw new Error(`manifesto de migrations invalido: ${audit.errors.join('; ')}`);
  }

  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort(compareMigrations);
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: sslConfig() });
  const compat = [];

  await client.connect();
  try {
    await client.query('BEGIN');
    await assertFreshTarget(client);
    if (bootstrapLocal) await bootstrapBarePostgres(client);

    for (const file of files) {
      const raw = readFileSync(path.join(migrationsDir, file), 'utf8');
      const patched = patchKnownMigrationIssues(file, raw);
      if (patched.reason) compat.push({ file, reason: patched.reason });
      try {
        await client.query(stripEmbeddedTransactionControl(patched.sql));
      } catch (error) {
        throw new Error(`Migration ${file}: ${error.message}`, { cause: error });
      }
    }

    if (commit) await client.query('COMMIT');
    else await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }

  console.log(`OK: ${files.length} migrations reexecutadas (${commit ? 'COMMIT' : 'DRY-RUN'})`);
  for (const item of compat) console.log(`compat: ${item.file} — ${item.reason}`);
}

main().catch((error) => {
  console.error(`ERRO: ${error.message}`);
  process.exit(1);
});
