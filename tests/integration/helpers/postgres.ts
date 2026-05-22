import { readdir, readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, '..', '..', '..', 'db', 'migrations');

export interface IntegrationDb {
  container: StartedPostgreSqlContainer;
  pool: Pool;
  connectionString: string;
}

export async function startPostgres(): Promise<IntegrationDb> {
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

  await applyMigrations(pool);

  return { container, pool, connectionString };
}

export async function stopPostgres(db: IntegrationDb): Promise<void> {
  await db.pool.end();
  await db.container.stop();
}

async function applyMigrations(pool: Pool): Promise<void> {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
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

    for (const file of files) {
      const raw = await readFile(join(MIGRATIONS_DIR, file), 'utf-8');
      const sql = patchKnownIssues(file, raw);
      await client.query(sql);
    }
  } finally {
    client.release();
  }
}

/**
 * Constroi connection string usando a role farejador_partner_app.
 * Substitui o usuario default (test) na connectionString do container.
 */
export function buildRestrictedConnectionString(connectionString: string): string {
  return connectionString.replace(/\/\/test:test@/, '//farejador_partner_app:test@');
}

/**
 * Patches in-memory de migrations existentes que nao compilam em Postgres 17
 * fresh. Nao toca em arquivo fonte — apenas adapta no carregamento dos testes.
 *
 * Item conhecido: 0020 declara `position TEXT` dentro de `RETURNS TABLE` na
 * function `commerce.find_compatible_tires`. `position` e palavra-chave em
 * contexto de declaracao de TABLE em Postgres 16+ — exige aspas duplas.
 * A 0025 ja recria essa function com `fitment_position`, entao em prod tudo
 * funciona. Mas pra subir banco fresh em CI/dev a 0020 precisa parsear.
 *
 * Correcao adequada seria editar a 0020 ou criar migration nova. Como esta
 * fora do escopo Portal Parceiro (auditoria 2026-05-21), patcheamos so aqui.
 */
function patchKnownIssues(file: string, sql: string): string {
  if (file === '0020_vehicle_fitment_validation.sql') {
    return sql
      .replace(/^(\s*)position(\s+)TEXT,$/m, '$1"position"$2TEXT,')
      .replace(/^(\s*)f\.position,$/gm, '$1f."position",')
      .replace(/f\.position\s*=\s*p_position/g, 'f."position" = p_position')
      .replace(/f\.position\s*=\s*'both'/g, 'f."position" = \'both\'')
      .replace(/(GROUP BY[^;]*?)f\.position,/g, '$1f."position",');
  }
  return sql;
}
