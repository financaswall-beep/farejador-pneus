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

// FAIL-CLOSED em prod (auditoria 2026-06-11, achado S1): sem PARTNER_DATABASE_URL,
// o portal cairia no DATABASE_URL principal (role postgres, BYPASSRLS) e o RLS
// viraria decoração — o isolamento entre parceiros dependeria só do WHERE de cada
// query. Melhor o painel fora do ar que vazando entre parceiros, então em prod o
// boot DERRUBA. Em dev/test o fallback continua valendo pro ambiente local.
if (!env.PARTNER_DATABASE_URL && env.FAREJADOR_ENV === 'prod') {
  throw new Error(
    'PARTNER_DATABASE_URL ausente com FAREJADOR_ENV=prod — o portal do parceiro NAO sobe sem a role restrita (farejador_partner_app), senao o RLS fica bypassado. Configure a env (Coolify ou .env.preview).',
  );
}

const partnerDatabaseUrl = env.PARTNER_DATABASE_URL ?? env.DATABASE_URL;

const usesSupabase =
  partnerDatabaseUrl.includes('supabase.co') || partnerDatabaseUrl.includes('supabase.com');

export const partnerPool = new Pool({
  // max=5 era pouco: o portal dispara ~12 chamadas de API ao abrir e elas faziam fila
  // esperando conexão (responseTime subia 1.5s→3.4s). 15 deixa as ~12 rodarem em paralelo.
  // Seguro com o pooler do Supabase (6543, multiplexa); de olho no teto de 60 conexões.
  connectionString: partnerDatabaseUrl,
  max: 15,
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
