/**
 * Testes de RLS efetivo — Etapa 5 V2 da auditoria 2026-05-21.
 *
 * Cobertura (10 testes minimos exigidos pelo Codex na revisao da V2):
 *   1. parceiro A com contexto A nao ve partner_orders de B (sem WHERE)
 *   2. idem pra partner_stock_levels
 *   3. idem pra finance.partner_expenses
 *   4. idem pra partner_purchases
 *   5. role restrita sem contexto = zero linhas em todas as tabelas
 *   6. validate_partner_token funciona sem SELECT direto em partner_access_tokens
 *   7. SELECT direto em partner_access_tokens falha (sem GRANT)
 *   8. views do portal respeitam isolamento (security_invoker)
 *   9. venda funciona com role restrita
 *   10. pool admin (BYPASSRLS) continua vendo tudo
 *
 * Pre-requisito: a migration 0044 ja foi aplicada no container de teste
 * (via helper applyMigrations) e a role 'farejador_partner_app' ja existe.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import {
  startPostgres,
  stopPostgres,
  buildRestrictedConnectionString,
  type IntegrationDb,
} from './helpers/postgres';
import { createPartnerFixture } from './helpers/partner-fixtures';

let db: IntegrationDb;
let restrictedPool: Pool;

beforeAll(async () => {
  db = await startPostgres();
  restrictedPool = new Pool({
    connectionString: buildRestrictedConnectionString(db.connectionString),
    max: 5,
  });
}, 180_000);

afterAll(async () => {
  if (restrictedPool) await restrictedPool.end();
  if (db) await stopPostgres(db);
});

// Helper: roda callback em transacao com app.partner_unit_id setado
async function withRestrictedContext<T>(
  partnerUnitId: string,
  callback: (client: import('pg').PoolClient) => Promise<T>,
): Promise<T> {
  const client = await restrictedPool.connect();
  try {
    await client.query('BEGIN');
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

describe('Etapa 5 V2 — RLS enforcement com role farejador_partner_app', () => {

  it('1. parceiro A com contexto A nao ve partner_orders de B (sem WHERE)', async () => {
    const a = await createPartnerFixture(db.pool, { slugSuffix: 'rls1a' + randomUUID().slice(0, 6) });
    const b = await createPartnerFixture(db.pool, { slugSuffix: 'rls1b' + randomUUID().slice(0, 6) });

    // B faz 1 venda via pool admin (BYPASSRLS)
    await db.pool.query(
      `INSERT INTO commerce.partner_orders (
         environment, unit_id, customer_name, total_amount, status, idempotency_key
       ) VALUES ('test', $1, 'Cliente B', 100, 'confirmed', 'iso1-' || gen_random_uuid())`,
      [b.unitId],
    );

    // A com contexto A faz SELECT sem WHERE
    await withRestrictedContext(a.partnerUnitId, async (client) => {
      const r = await client.query('SELECT * FROM commerce.partner_orders');
      expect(r.rowCount).toBe(0);  // RLS estrita filtra
    });
  });

  it('2. parceiro A nao ve partner_stock_levels de B (sem WHERE)', async () => {
    const a = await createPartnerFixture(db.pool, { slugSuffix: 'rls2a' + randomUUID().slice(0, 6) });
    const b = await createPartnerFixture(db.pool, { slugSuffix: 'rls2b' + randomUUID().slice(0, 6), initialStockQty: 10 });

    await withRestrictedContext(a.partnerUnitId, async (client) => {
      const r = await client.query('SELECT * FROM commerce.partner_stock_levels');
      // Soh deveria ver os itens da fixture A (que tem 1)
      const idsB = r.rows.map((row: { id: string }) => row.id).filter((id: string) => id === b.stockId);
      expect(idsB).toHaveLength(0);
    });
  });

  it('3. parceiro A nao ve finance.partner_expenses de B (sem WHERE)', async () => {
    const a = await createPartnerFixture(db.pool, { slugSuffix: 'rls3a' + randomUUID().slice(0, 6) });
    const b = await createPartnerFixture(db.pool, { slugSuffix: 'rls3b' + randomUUID().slice(0, 6) });

    // B cria uma despesa
    await db.pool.query(
      `INSERT INTO finance.partner_expenses (environment, unit_id, category, description, amount)
       VALUES ('test', $1, 'rent', 'aluguel B', 1000)`,
      [b.unitId],
    );

    await withRestrictedContext(a.partnerUnitId, async (client) => {
      const r = await client.query('SELECT * FROM finance.partner_expenses');
      expect(r.rowCount).toBe(0);
    });
  });

  it('4. parceiro A nao ve partner_purchases de B (sem WHERE)', async () => {
    const a = await createPartnerFixture(db.pool, { slugSuffix: 'rls4a' + randomUUID().slice(0, 6) });
    const b = await createPartnerFixture(db.pool, { slugSuffix: 'rls4b' + randomUUID().slice(0, 6) });

    await db.pool.query(
      `INSERT INTO commerce.partner_purchases (environment, unit_id, supplier_name, total_amount)
       VALUES ('test', $1, 'Fornecedor B', 500)`,
      [b.unitId],
    );

    await withRestrictedContext(a.partnerUnitId, async (client) => {
      const r = await client.query('SELECT * FROM commerce.partner_purchases');
      expect(r.rowCount).toBe(0);
    });
  });

  it('5. role restrita SEM contexto (GUC nao setado) = zero linhas em todas as tabelas', async () => {
    // Cria fixture pra garantir que tem dados
    await createPartnerFixture(db.pool, { slugSuffix: 'rls5' + randomUUID().slice(0, 6) });

    const client = await restrictedPool.connect();
    try {
      // SEM SET LOCAL — current_partner_unit() retorna NULL — policy estrita bloqueia
      for (const t of [
        'commerce.partner_orders',
        'commerce.partner_order_items',
        'commerce.partner_purchases',
        'commerce.partner_purchase_items',
        'commerce.partner_stock_levels',
      ]) {
        const r = await client.query(`SELECT count(*)::int AS c FROM ${t}`);
        expect(r.rows[0].c).toBe(0);
      }
      const r1 = await client.query('SELECT count(*)::int AS c FROM finance.partner_expenses');
      expect(r1.rows[0].c).toBe(0);
      const r2 = await client.query('SELECT count(*)::int AS c FROM network.partners');
      expect(r2.rows[0].c).toBe(0);
      const r3 = await client.query('SELECT count(*)::int AS c FROM network.partner_units');
      expect(r3.rows[0].c).toBe(0);
    } finally {
      client.release();
    }
  });

  it('6. validate_partner_token funciona via SECURITY DEFINER (sem SELECT direto em partner_access_tokens)', async () => {
    const f = await createPartnerFixture(db.pool, { slugSuffix: 'rls6' + randomUUID().slice(0, 6) });

    const r = await restrictedPool.query(
      'SELECT * FROM network.validate_partner_token($1, $2, $3)',
      ['test', f.slug, f.tokenPlain],
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].partner_unit_id).toBe(f.partnerUnitId);
    expect(r.rows[0].unit_id).toBe(f.unitId);
    expect(r.rows[0].slug).toBe(f.slug);
  });

  it('7. SELECT direto em partner_access_tokens falha pra role restrita (sem GRANT)', async () => {
    await expect(
      restrictedPool.query('SELECT * FROM network.partner_access_tokens'),
    ).rejects.toThrow(/permission denied/);
  });

  it('8. views do portal respeitam isolamento (security_invoker)', async () => {
    const a = await createPartnerFixture(db.pool, { slugSuffix: 'rls8a' + randomUUID().slice(0, 6) });
    const b = await createPartnerFixture(db.pool, { slugSuffix: 'rls8b' + randomUUID().slice(0, 6) });

    // B faz venda
    await db.pool.query(
      `INSERT INTO commerce.partner_orders (
         environment, unit_id, customer_name, total_amount, status, idempotency_key
       ) VALUES ('test', $1, 'B', 100, 'confirmed', 'iso8-' || gen_random_uuid())`,
      [b.unitId],
    );

    await withRestrictedContext(a.partnerUnitId, async (client) => {
      // network.partner_unit_summary com security_invoker — deve filtrar
      const r1 = await client.query(`SELECT * FROM network.partner_unit_summary`);
      // A com contexto A so ve a propria unidade
      expect(r1.rowCount).toBe(1);
      expect(r1.rows[0].unit_id).toBe(a.unitId);

      // commerce.partner_orders_full com security_invoker — nao ve venda de B
      const r2 = await client.query(`SELECT * FROM commerce.partner_orders_full`);
      const seesB = r2.rows.filter((row: { unit_id: string }) => row.unit_id === b.unitId);
      expect(seesB).toHaveLength(0);
    });
  });

  it('9. venda funciona com role restrita (function register_partner_local_order)', async () => {
    const a = await createPartnerFixture(db.pool, { slugSuffix: 'rls9' + randomUUID().slice(0, 6), initialStockQty: 10 });

    await withRestrictedContext(a.partnerUnitId, async (client) => {
      const r = await client.query<{ order_id: string }>(
        `SELECT commerce.register_partner_local_order(
           $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11
         ) AS order_id`,
        [
          'test',
          a.unitId,
          'Cliente RLS9',
          null,
          JSON.stringify([{ partner_stock_id: a.stockId, quantity: 1, unit_price: 100 }]),
          'pix',
          'pickup',
          null,
          `partner:${a.slug}`,
          `rls9-${randomUUID()}`,
          'porta',
        ],
      );
      expect(r.rows[0].order_id).toBeTruthy();
    });

    // Confirma via pool admin que o estoque baixou
    const stock = await db.pool.query(
      `SELECT quantity_on_hand FROM commerce.partner_stock_levels WHERE id = $1`,
      [a.stockId],
    );
    expect(stock.rows[0].quantity_on_hand).toBe(9);
  });

  it('10. pool admin (com BYPASSRLS implicito do owner) continua vendo tudo', async () => {
    // Container de teste usa role 'test' que e owner — BYPASSRLS efetivamente
    // (owner ignora policies se nao tiver FORCE RLS, que nao usamos)
    await createPartnerFixture(db.pool, { slugSuffix: 'rls10a' + randomUUID().slice(0, 6) });
    await createPartnerFixture(db.pool, { slugSuffix: 'rls10b' + randomUUID().slice(0, 6) });

    const r = await db.pool.query('SELECT count(*)::int AS c FROM network.partner_units');
    // Pelo menos as 2 fixtures que acabamos de criar
    expect(r.rows[0].c).toBeGreaterThanOrEqual(2);
  });
});
