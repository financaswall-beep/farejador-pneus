import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('Etapa 3 — backfill e paridade do livro central', () => {
  let db: IntegrationDb;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
      CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'emergency-token',
      WHOLESALE_FINANCE: 'true', WHOLESALE_MATRIZ_RETAIL_COST: 'true',
      MATRIZ_CENTRAL_LEDGER: 'false',
    });
    vi.resetModules();
    db = await startPostgres();
  }, 180_000);

  afterAll(async () => {
    if (db) await stopPostgres(db);
    process.env.MATRIZ_CENTRAL_LEDGER = 'false';
  });

  it('preenche fontes antigas uma vez e termina com diferenca zero', async () => {
    const { registerWholesaleSupplier } =
      await import('../../src/admin/painel/queries-fornecedores.js');
    const { registerWholesalePurchase } =
      await import('../../src/admin/painel/queries-fornecedores-registro.js');
    const { registerWholesaleSale } =
      await import('../../src/admin/painel/queries-atacado-vendas.js');
    const { registerWalkinOrder } =
      await import('../../src/admin/painel/queries-pedidos-acoes.js');
    const { addWholesaleStockEntryComRotulo } =
      await import('../../src/admin/painel/queries-galpao-movimentos.js');

    const unit = await db.pool.query<{ id: string }>(
      `INSERT INTO core.units (environment,slug,name,is_active)
       VALUES ('test','main','Matriz backfill',true) RETURNING id`,
    );
    const product = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.products
         (environment,product_code,product_name,product_type)
       VALUES ('test','BACKFILL-LEDGER','Pneu backfill','tire') RETURNING id`,
    );
    const measure = '299/49-19';
    await db.pool.query(
      `INSERT INTO commerce.tire_specs
         (environment,product_id,tire_size,width_mm,aspect_ratio,rim_diameter)
       VALUES ('test',$1,$2,299,49,19)`,
      [product.rows[0]!.id, measure],
    );
    const legacyContact = await db.pool.query<{ id: string }>(
      `INSERT INTO core.contacts (environment,chatwoot_contact_id,name)
       VALUES ('test',990001,'Cliente cancelado sem movimento') RETURNING id`,
    );
    const legacyCancelled = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.orders
         (environment,contact_id,unit_id,total_amount,status,fulfillment_mode,
          payment_method,closed_by)
       VALUES ('test',$1,$2,99,'cancelled','pickup','pix','legacy:test')
       RETURNING id`,
      [legacyContact.rows[0]!.id, unit.rows[0]!.id],
    );
    await db.pool.query(
      `INSERT INTO commerce.order_items
         (environment,order_id,product_id,quantity,unit_price,discount_amount,
          matriz_unit_cost)
       VALUES ('test',$1,$2,1,99,0,NULL)`,
      [legacyCancelled.rows[0]!.id, product.rows[0]!.id],
    );
    await addWholesaleStockEntryComRotulo({
      environment: 'test', measure, quantity_in: 12, unit_cost: 20,
      entry_nature: 'inventory_found', reason: 'estoque anterior ao livro central',
      idempotency_key: randomUUID(),
    }, db.pool);

    const supplier = await registerWholesaleSupplier({
      environment: 'test', name: 'Fornecedor backfill',
    }, db.pool);
    await registerWholesalePurchase({
      environment: 'test', supplier_id: supplier.id,
      items: [{ measure, quantity: 2, unit_cost: 20 }],
      purchased_at: '2026-07-01T12:00:00Z',
      payment_status: 'paid', receipt_status: 'received',
      created_by: 'owner:legacy', idempotency_key: randomUUID(),
    }, db.pool);

    const buyer = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.wholesale_customers (environment,name)
       VALUES ('test','Cliente backfill') RETURNING id`,
    );
    await registerWholesaleSale({
      environment: 'test', customer_id: buyer.rows[0]!.id,
      items: [{ measure, quantity: 2, unit_price: 50 }],
      sold_at: '2026-07-02T12:00:00Z', payment_status: 'paid',
      created_by: 'owner:legacy', idempotency_key: randomUUID(),
    }, db.pool);

    await registerWalkinOrder({
      environment: 'test', customer_name: 'Cliente varejo backfill',
      unit_id: unit.rows[0]!.id,
      items: [{ product_id: product.rows[0]!.id, quantity: 2, unit_price: 70 }],
      payment_method: 'pix', fulfillment_mode: 'pickup',
      actor_label: 'owner:legacy', idempotency_key: randomUUID(),
      source_tag: 'walkin_balcao',
    }, db.pool);

    const beforeLedger = await db.pool.query<{ count: number }>(
      `SELECT count(*)::int count FROM finance.matriz_ledger_transactions
        WHERE environment='test'`,
    );
    expect(beforeLedger.rows[0]!.count).toBe(0);

    process.env.MATRIZ_CENTRAL_LEDGER = 'true';
    vi.resetModules();
    const { runMatrizStage3LedgerBackfill } =
      await import('../../src/admin/painel/matriz-ledger-stage3-reconciliation.js');
    const first = await runMatrizStage3LedgerBackfill(
      { environment: 'test', limit: 100 }, db.pool,
    );
    expect(first.enabled).toBe(true);
    expect(first.processed).toEqual({
      purchases: 1,
      wholesale_sales: 1,
      retail_sales: 2,
      inventory_adjustments: 1,
    });
    expect(first.reconciliation).toMatchObject({
      status: 'green', total_problems: 0, amount_mismatches: 0,
      orphan_ledger: 0, duplicate_sources: 0,
    });

    const second = await runMatrizStage3LedgerBackfill(
      { environment: 'test', limit: 100 }, db.pool,
    );
    expect(second.processed).toEqual({
      purchases: 0,
      wholesale_sales: 0,
      retail_sales: 0,
      inventory_adjustments: 0,
    });
    expect(second.reconciliation.total_problems).toBe(0);
  });
});
