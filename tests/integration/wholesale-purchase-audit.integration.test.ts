import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('fechamento das auditorias funcional e matematica de Compras', () => {
  let db: IntegrationDb;
  let supplierId: string;
  const measure = '299/98-28';
  const brand = 'Pirelli';
  let registerPurchase: typeof import(
    '../../src/admin/painel/queries-fornecedores-registro.js'
  ).registerWholesalePurchase;
  let settlePurchase: typeof import(
    '../../src/admin/painel/queries-financeiro-integridade.js'
  ).settleWholesalePurchasePayment;
  let listStock: typeof import('../../src/admin/painel/queries-galpao.js').listWholesaleStock;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
      CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'emergency-token',
      WHOLESALE_FINANCE: 'true', MATRIZ_CENTRAL_LEDGER: 'true',
    });
    vi.resetModules();
    db = await startPostgres();
    ({ registerWholesalePurchase: registerPurchase }
      = await import('../../src/admin/painel/queries-fornecedores-registro.js'));
    ({ settleWholesalePurchasePayment: settlePurchase }
      = await import('../../src/admin/painel/queries-financeiro-integridade.js'));
    ({ listWholesaleStock: listStock }
      = await import('../../src/admin/painel/queries-galpao.js'));

    const product = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.products
         (environment,product_code,product_name,product_type,brand,tire_condition)
       VALUES ('test','AUD-PURCHASE','Pneu auditoria','tire',$1,'novo') RETURNING id`,
      [brand],
    );
    await db.pool.query(
      `INSERT INTO commerce.tire_specs
         (environment,product_id,tire_size,width_mm,aspect_ratio,rim_diameter)
       VALUES ('test',$1,$2,299,98,28)`, [product.rows[0]!.id, measure],
    );
    await db.pool.query(
      `INSERT INTO commerce.matriz_product_prices
         (environment,product_id,price_amount,currency,valid_from)
       VALUES ('test',$1,100,'BRL','2026-01-01T00:00:00Z')`,
      [product.rows[0]!.id],
    );
    const supplier = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.wholesale_suppliers (environment,name)
       VALUES ('test','Fornecedor auditoria final') RETURNING id`,
    );
    supplierId = supplier.rows[0]!.id;
  }, 180_000);

  afterAll(async () => {
    if (db) await stopPostgres(db);
    process.env.MATRIZ_CENTRAL_LEDGER = 'false';
  });

  function purchase(cost: number, purchaseBrand = brand) {
    return registerPurchase({
      environment: 'test', supplier_id: supplierId, created_by: 'owner:audit',
      purchased_at: '2026-08-10T12:00:00-03:00', payment_status: 'paid',
      receipt_status: 'received', idempotency_key: randomUUID(),
      items: [{ measure, brand: purchaseBrand, tire_condition: 'novo',
        quantity: 1, unit_cost: cost }],
    }, db.pool);
  }

  it('preserva custo medio subcentavo e reconcilia o valor total do estoque', async () => {
    expect((await purchase(0.01)).catalog_blockers).toEqual([]);
    expect((await purchase(0.02)).catalog_blockers).toEqual([]);
    const proof = await db.pool.query<{
      quantity_on_hand: number; unit_cost: string; stock_value: string; ledger_value: string;
    }>(
      `SELECT s.quantity_on_hand,s.unit_cost::text,
              (s.quantity_on_hand*s.unit_cost)::numeric(14,2)::text stock_value,
              (SELECT sum(t.amount)::text
                 FROM finance.matriz_ledger_transactions t
                WHERE t.environment='test'
                  AND t.source_type='commerce.wholesale_purchase.accrual'
                  AND t.source_id IN (
                    SELECT p.id::text FROM commerce.wholesale_purchases p
                    JOIN commerce.wholesale_purchase_items i ON i.purchase_id=p.id
                    WHERE p.environment='test' AND i.measure=$1 AND i.brand=$2
                  )) ledger_value
         FROM commerce.wholesale_stock s
        WHERE s.environment='test' AND s.measure=$1 AND s.brand=$2
          AND s.tire_condition='novo'`,
      [measure, brand],
    );
    expect(proof.rows[0]).toEqual({ quantity_on_hand: 2, unit_cost: '0.015000',
      stock_value: '0.03', ledger_value: '0.03' });
  });

  it('avisa de forma estruturada quando Catalogo ainda bloqueia a venda', async () => {
    const result = await purchase(10, 'Marca Ainda Sem Produto');
    expect(result.catalog_blockers).toEqual([{
      measure, brand: 'Marca Ainda Sem Produto', tire_condition: 'novo',
      reason: 'catalog_product_missing', product_id: null,
    }]);
  });

  it('o banco recusa datas factuais futuras e vencimento anterior a compra', async () => {
    const future = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    await expect(registerPurchase({
      environment: 'test', supplier_id: supplierId, created_by: 'owner:audit',
      purchased_at: future, payment_status: 'paid', receipt_status: 'pending',
      idempotency_key: randomUUID(), items: [{ measure, brand, tire_condition: 'novo',
        quantity: 1, unit_cost: 10 }],
    }, db.pool)).rejects.toThrow('purchased_at_future');
    await expect(registerPurchase({
      environment: 'test', supplier_id: supplierId, created_by: 'owner:audit',
      purchased_at: '2026-08-10T12:00:00-03:00', paid_at: future,
      payment_status: 'paid', receipt_status: 'pending', idempotency_key: randomUUID(),
      items: [{ measure, brand, tire_condition: 'novo', quantity: 1, unit_cost: 10 }],
    }, db.pool)).rejects.toThrow('paid_at_future');
    await expect(registerPurchase({
      environment: 'test', supplier_id: supplierId, created_by: 'owner:audit',
      purchased_at: '2026-08-10T12:00:00-03:00', payment_status: 'pending',
      due_date: '2026-08-09', receipt_status: 'pending', idempotency_key: randomUUID(),
      items: [{ measure, brand, tire_condition: 'novo', quantity: 1, unit_cost: 10 }],
    }, db.pool)).rejects.toThrow('due_date_before_purchase');

    const payable = await registerPurchase({
      environment: 'test', supplier_id: supplierId, created_by: 'owner:audit',
      purchased_at: '2026-08-10T12:00:00-03:00', payment_status: 'pending',
      due_date: '2026-09-10', receipt_status: 'pending', idempotency_key: randomUUID(),
      items: [{ measure, brand, tire_condition: 'novo', quantity: 1, unit_cost: 10 }],
    }, db.pool);
    await expect(settlePurchase(payable.purchase_id, 'test', db.pool, {
      actor_label: 'owner:audit', paid_at: future, idempotency_key: randomUUID(),
    })).rejects.toThrow('paid_at_future');
    expect((await db.pool.query<{ payment_status: string }>(
      `SELECT payment_status FROM commerce.wholesale_purchases WHERE id=$1`,
      [payable.purchase_id],
    )).rows[0]?.payment_status).toBe('pending');
  });

  it('giro de reposicao usa todas as vendas dos ultimos 30 dias, nao as ultimas 50 linhas', async () => {
    await db.pool.query(
      `INSERT INTO commerce.wholesale_stock_movements
         (environment,measure,brand,tire_condition,op,qty_before,qty_after,source,created_at)
       SELECT 'test',$1,$2,'novo','update',1,0,'venda_atacado',now()-INTERVAL '5 days'
         FROM generate_series(1,75)`, [measure, brand],
    );
    await db.pool.query(
      `INSERT INTO commerce.wholesale_stock_movements
         (environment,measure,brand,tire_condition,op,qty_before,qty_after,source,created_at)
       SELECT 'test',$1,$2,'novo','update',1,0,'venda_atacado',now()-INTERVAL '31 days'
         FROM generate_series(1,10)`, [measure, brand],
    );
    const row = (await listStock('test', db.pool)).find((item) =>
      item.measure === measure && item.brand === brand && item.tire_condition === 'novo');
    expect(row?.sales_30d).toBe(75);
  });
});
