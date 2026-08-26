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
  let confirmPurchase: typeof import(
    '../../src/admin/painel/queries-fornecedores-registro.js'
  ).confirmWholesalePurchase;
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
    ({ registerWholesalePurchase: registerPurchase, confirmWholesalePurchase: confirmPurchase }
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

  it('gera ordem, parcela o compromisso e concilia recusa parcial no recebimento', async () => {
    const purchase = await registerPurchase({
      environment: 'test', supplier_id: supplierId, created_by: 'owner:audit',
      purchased_at: '2026-08-20T12:00:00-03:00', payment_status: 'pending',
      receipt_status: 'pending', freight_amount: 5, discount_amount: 2,
      installments: [
        { due_date: '2026-09-20', amount: 15 },
        { due_date: '2026-10-20', amount: 18 },
      ],
      idempotency_key: randomUUID(), items: [{ measure, brand, tire_condition: 'novo',
        quantity: 3, unit_cost: 10 }],
    }, db.pool);
    expect(purchase).toMatchObject({
      order_code: expect.stringMatching(/^OC-2026-\d{6}$/),
      products_amount: '30.00', freight_amount: '5.00',
      discount_amount: '2.00', total_amount: '33.00',
    });
    const item = await db.pool.query<{ id: string }>(
      `SELECT id FROM commerce.wholesale_purchase_items
        WHERE environment='test' AND purchase_id=$1`, [purchase.purchase_id],
    );
    await confirmPurchase({
      environment: 'test', purchase_id: purchase.purchase_id,
      confirmed_by: 'owner:conference', idempotency_key: randomUUID(),
      items: [{ item_id: item.rows[0]!.id, accepted_quantity: 2 }],
    }, db.pool);

    const proof = await db.pool.query<{
      total_amount: string; products_amount: string; accepted_quantity: number;
      allocated_cost: string; installments_total: string; installments: string[];
      obligation_balance: string; stock_delta: number;
    }>(
      `SELECT p.total_amount::text,p.products_amount::text,i.accepted_quantity,
              i.allocated_cost::text,
              (SELECT sum(amount)::text FROM commerce.wholesale_purchase_installments pi
                WHERE pi.environment=p.environment AND pi.purchase_id=p.id) installments_total,
              (SELECT array_agg(amount::text ORDER BY installment_number)
                 FROM commerce.wholesale_purchase_installments pi
                WHERE pi.environment=p.environment AND pi.purchase_id=p.id) installments,
              (SELECT finance.matriz_ledger_obligation_balance('test',t.id)::text
                 FROM finance.matriz_ledger_transactions t
                WHERE t.environment='test'
                  AND t.source_type='commerce.wholesale_purchase.accrual'
                  AND t.source_id=p.id::text) obligation_balance,
              (SELECT COALESCE(sum(m.qty_delta),0)::int
                 FROM commerce.wholesale_stock_movements m
                WHERE m.environment=p.environment AND m.ref=p.id::text) stock_delta
         FROM commerce.wholesale_purchases p
         JOIN commerce.wholesale_purchase_items i
           ON i.environment=p.environment AND i.purchase_id=p.id
        WHERE p.environment='test' AND p.id=$1`, [purchase.purchase_id],
    );
    expect(proof.rows[0]).toEqual({
      total_amount: '23.00', products_amount: '20.00', accepted_quantity: 2,
      allocated_cost: '23.00', installments_total: '23.00',
      installments: ['15.00', '8.00'], obligation_balance: '23.00', stock_delta: 2,
    });

    const { getMatrizLedgerOpenItems } = await import(
      '../../src/admin/painel/matriz-ledger-open-items.js');
    const agenda = (await getMatrizLedgerOpenItems('test', db.pool)).a_pagar.itens
      .filter((row) => row.obligation_id && row.id.startsWith(purchase.purchase_id));
    expect(agenda.map((row) => ({ valor: row.valor, due: row.due_date }))).toEqual([
      { valor: '15.00', due: '2026-09-20' },
      { valor: '8.00', due: '2026-10-20' },
    ]);

    // A trava do banco também impede usar um ajuste de outra compra para
    // reduzir artificialmente esta obrigação.
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const { postMatrizLedgerTransaction } = await import(
        '../../src/admin/painel/matriz-ledger-posting.js');
      const forgedAdjustmentId = await postMatrizLedgerTransaction(client, {
        environment: 'test', sourceType: 'commerce.wholesale_purchase.adjustment',
        sourceId: randomUUID(), kind: 'purchase_quantity_adjustment', amount: 1,
        occurredAt: '2026-08-20T15:00:00-03:00', description: 'Ajuste cruzado inválido',
        createdBy: 'owner:audit', metadata: {}, lines: [
          { account_code: 'accounts_payable', account_class: 'liability', side: 'debit', amount: 1 },
          { account_code: 'inventory_in_transit', account_class: 'asset', side: 'credit', amount: 1 },
        ],
      });
      const obligation = await client.query<{ id: string }>(
        `SELECT id FROM finance.matriz_ledger_transactions
          WHERE environment='test' AND source_type='commerce.wholesale_purchase.accrual'
            AND source_id=$1::text`, [purchase.purchase_id],
      );
      await client.query(
        `INSERT INTO finance.matriz_ledger_payments
          (environment,obligation_transaction_id,payment_transaction_id,
           payment_kind,amount,paid_at,created_by)
         VALUES ('test',$1,$2,'adjustment',1,'2026-08-20T15:00:00-03:00','owner:audit')`,
        [obligation.rows[0]!.id, forgedAdjustmentId],
      );
      await expect(client.query('SET CONSTRAINTS ALL IMMEDIATE'))
        .rejects.toThrow('matriz_ledger_invalid_adjustment_transaction');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }

    // Simula uma compra antiga sem ordem e prova que o vínculo posterior é só
    // organizacional: não reposta livro nem toca no galpão.
    await db.pool.query(
      `UPDATE commerce.wholesale_purchases SET purchase_order_id=NULL
        WHERE environment='test' AND id=$1`, [purchase.purchase_id],
    );
    const beforeLink = await db.pool.query<{ ledger: number; movements: number }>(
      `SELECT (SELECT count(*)::int FROM finance.matriz_ledger_transactions
                WHERE environment='test' AND source_id=$1) ledger,
              (SELECT count(*)::int FROM commerce.wholesale_stock_movements
                WHERE environment='test' AND ref=$1) movements`, [purchase.purchase_id],
    );
    const { linkWholesalePurchaseOrder } = await import(
      '../../src/admin/painel/queries-purchase-orders.js');
    const linked = await linkWholesalePurchaseOrder({
      environment: 'test', purchase_id: purchase.purchase_id,
      order_id: purchase.order_id, linked_by: 'owner:audit',
      idempotency_key: randomUUID(),
    }, db.pool);
    expect(linked.order_code).toBe(purchase.order_code);
    const afterLink = await db.pool.query<{ ledger: number; movements: number; order_id: string }>(
      `SELECT (SELECT count(*)::int FROM finance.matriz_ledger_transactions
                WHERE environment='test' AND source_id=$1::text) ledger,
              (SELECT count(*)::int FROM commerce.wholesale_stock_movements
                WHERE environment='test' AND ref=$1::text) movements,
              purchase_order_id order_id
         FROM commerce.wholesale_purchases WHERE environment='test' AND id=$1::uuid`,
      [purchase.purchase_id],
    );
    expect(afterLink.rows[0]).toEqual({ ...beforeLink.rows[0], order_id: purchase.order_id });
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

  it('relatorio de reposicao enxerga compra pendente sem somar ao estoque', async () => {
    const before = (await listStock('test', db.pool)).find((item) =>
      item.measure === measure && item.brand === brand && item.tire_condition === 'novo');
    await registerPurchase({
      environment: 'test', supplier_id: supplierId, created_by: 'owner:audit',
      purchased_at: '2026-08-25T10:00:00-03:00', payment_status: 'paid',
      receipt_status: 'pending', idempotency_key: randomUUID(),
      items: [{ measure, brand, tire_condition: 'novo', quantity: 4, unit_cost: 20 }],
    }, db.pool);

    const after = (await listStock('test', db.pool)).find((item) =>
      item.measure === measure && item.brand === brand && item.tire_condition === 'novo');
    expect(after?.quantity_on_hand).toBe(before?.quantity_on_hand);
    expect(after?.in_transit_quantity).toBe((before?.in_transit_quantity ?? 0) + 4);
  });
});
