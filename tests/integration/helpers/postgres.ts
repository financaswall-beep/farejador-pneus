import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, '..', '..', '..', 'db', 'migrations');
const require = createRequire(import.meta.url);
const { patchKnownMigrationIssues } = require('../../../scripts/migration-compat.cjs') as {
  patchKnownMigrationIssues: (file: string, sql: string) => { sql: string };
};

export interface IntegrationDb {
  container: StartedPostgreSqlContainer;
  pool: Pool;
  connectionString: string;
}

export async function startPostgres(options: { throughMigration?: string } = {}): Promise<IntegrationDb> {
  // Imagem alinhada com prod (Supabase usa Postgres 17.x).
  const container = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('farejador_test')
    .withUsername('test')
    .withPassword('test')
    .start();

  // Workaround Docker Desktop + WSL2 no Windows: getConnectionUri() retorna
  // "postgres://...@localhost:PORT/..." mas o forwarding so funciona em IPv4.
  // Como Node.js resolve "localhost" pra IPv6 (::1), conexao falha com
  // ECONNRESET. Substituindo por 127.0.0.1 forca IPv4.
  const connectionString = container.getConnectionUri().replace('@localhost:', '@127.0.0.1:');
  const pool = new Pool({ connectionString, max: 5 });

  await applyMigrations(pool, options.throughMigration);

  return { container, pool, connectionString };
}

export async function stopPostgres(db: IntegrationDb): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    db.pool.end(),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(
        `postgres_pool_end_timeout:total=${db.pool.totalCount},idle=${db.pool.idleCount},waiting=${db.pool.waitingCount}`,
      )), 10_000);
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
  await db.container.stop();
}

async function applyMigrations(pool: Pool, throughMigration?: string): Promise<void> {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => !throughMigration || f <= throughMigration)
    .sort();

  const client = await pool.connect();
  try {
    // Etapa 5 V2: cria a role 'farejador_partner_app' antes das migrations.
    // A 0044 supoe que a role ja existe (criacao real e via runbook em prod).
    // Em testes, criamos com senha 'test' (sem implicacao de seguranca — o
    // container e efemero e nao expoe rede externa).
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'farejador_partner_app') THEN
          CREATE ROLE farejador_partner_app LOGIN PASSWORD 'test' NOSUPERUSER NOBYPASSRLS NOINHERIT;
        END IF;
      END $$;
    `);
    // Postgres puro nao traz pg_cron. As migrations so precisam registrar o
    // agendamento; no container, um stub preserva o parse sem executar jobs.
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS cron;
      CREATE OR REPLACE FUNCTION cron.schedule(text, text, text)
      RETURNS bigint LANGUAGE sql AS 'SELECT 1::bigint';
    `);

    for (const file of files) {
      const raw = await readFile(join(MIGRATIONS_DIR, file), 'utf-8');
      const sql = patchKnownMigrationIssues(file, raw).sql;
      try {
        await client.query(sql);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Migration ${file}: ${message}`, { cause: error });
      }
    }
  } finally {
    client.release();
  }
}

/** Aplica um unico arquivo para provar sequencias de deploy/hotfix. */
export async function applyMigrationFile(pool: Pool, file: string): Promise<void> {
  if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(file)) throw new Error('invalid_migration_file');
  const raw = await readFile(join(MIGRATIONS_DIR, file), 'utf-8');
  await pool.query(patchKnownMigrationIssues(file, raw).sql);
}

/**
 * Constroi connection string usando a role farejador_partner_app.
 * Substitui o usuario default (test) na connectionString do container.
 */
export function buildRestrictedConnectionString(connectionString: string): string {
  return connectionString.replace(/\/\/test:test@/, '//farejador_partner_app:test@');
}
