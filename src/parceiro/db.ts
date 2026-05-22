/**
 * Pool de conexao isolado pro Portal Parceiro.
 *
 * Usa role 'farejador_partner_app' sem BYPASSRLS — RLS efetivamente
 * aplica. Bot/admin continuam no pool global de src/persistence/db.ts
 * com role 'postgres'.
 *
 * Etapa 5 V2 da auditoria 2026-05-21.
 */

import { Pool, type PoolClient } from 'pg';
import { env } from '../shared/config/env.js';
import { logger } from '../shared/logger.js';

// Se PARTNER_DATABASE_URL nao estiver setado, faz fallback no DATABASE_URL
// principal. Em prod isso e log de warning — Etapa 5 nao esta efetivamente
// enforced. Em dev/test/staging e OK pra nao quebrar ambientes antigos.
const partnerDatabaseUrl = env.PARTNER_DATABASE_URL ?? env.DATABASE_URL;

if (!env.PARTNER_DATABASE_URL && env.FAREJADOR_ENV === 'prod') {
  logger.warn(
    'PARTNER_DATABASE_URL nao configurado em prod — Etapa 5 RLS nao esta enforced!',
  );
}

const usesSupabase =
  partnerDatabaseUrl.includes('supabase.co') || partnerDatabaseUrl.includes('supabase.com');

export const partnerPool = new Pool({
  connectionString: partnerDatabaseUrl,
  max: 5,
  ssl: (env.DATABASE_SSL || usesSupabase) ? { rejectUnauthorized: false } : undefined,
});

partnerPool.on('error', (err) => {
  logger.error({ err }, 'unexpected partner pool PostgreSQL error');
});

/**
 * Executa callback dentro de uma transacao com app.partner_unit_id setado.
 *
 * V2 (pos-Codex): policies sao estritas (IS NOT NULL AND ...). Sem GUC setado
 * = zero linhas pra role restrita. Esse wrapper E obrigatorio em TODA query
 * do portal. Esquecer = portal vazio (correto: defesa em profundidade) em vez
 * de portal vazando dados (errado).
 *
 * O parametro partnerUnitId e network.partner_units.id (interno do schema
 * network). Pra tabelas que usam unit_id (= core.units.id), o banco usa o
 * helper network.current_partner_core_unit() que resolve via subquery.
 */
export async function withPartnerContext<T>(
  partnerUnitId: string,
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await partnerPool.connect();
  try {
    await client.query('BEGIN');
    // set_config com terceiro arg true = is_local (equivalente ao SET LOCAL)
    await client.query("SELECT set_config('app.partner_unit_id', $1, true)", [partnerUnitId]);
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
