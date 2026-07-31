import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('Etapa 3 — vendas de atacado no livro central', () => {
  let db: IntegrationDb;
  let sequence = 0;
  let registerSale: typeof import(
    '../../src/admin/painel/queries-atacado-vendas.js'
  ).registerWholesaleSale;
  let settleSale: typeof import(
    '../../src/admin/painel/queries-financeiro-integridade.js'
  ).settleWholesaleOrderPayment;
  let cancelSale: typeof import(
    '../../src/admin/painel/queries-atacado-cancelar.js'
  ).cancelWholesaleSale;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
      CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'emergency-token',
      WHOLESALE_FINANCE: 'true', MATRIZ_CENTRAL_LEDGER: 'true',
    });
    vi.resetModules();
    db = await startPostgres();
    ({ registerWholesaleSale: registerSale }
      = await import('../../src/admin/painel/queries-atacado-vendas.js'));
    ({ settleWholesaleOrderPayment: settleSale }
      = await import('../../src/admin/painel/queries-financeiro-integridade.js'));
    ({ cancelWholesaleSale: cancelSale }
      = await import('../../src/admin/painel/queries-atacado-cancelar.js'));
  }, 180_000);

  afterAll(async () => {
    if (db) await stopPostgres(db);
    process.env.MATRIZ_CENTRAL_LEDGER = 'false';
  });

  async function fixture(quantity = 5, unitCost = 20) {
    sequence += 1;
    const measure = `${240 + sequence}/${35 + sequence}-${13 + sequence}`;
    const product = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.products
         (environment,product_code,product_name,product_type)
       VALUES ('test',$1,$2,'tire') RETURNING id`,
      [`LEDGER-S-${sequence}`, `Pneu venda livro ${sequence}`],
    );
    await db.pool.query(
      `INSERT INTO commerce.tire_specs
         (environment,product_id,tire_size,width_mm,aspect_ratio,rim_diameter)
       VALUES ('test',$1,$2,$3,$4,$5)`,
      [product.rows[0]!.id, measure, 240 + sequence, 35 + sequence, 13 + sequence],
    );
    await db.pool.query(
      `INSERT INTO commerce.wholesale_stock
         (environment,measure,quantity_on_hand,unit_cost)
       VALUES ('test',$1,$2,$3)`,
      [measure, quantity, unitCost],
    );
    const buyer = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.wholesale_customers (environment,name)
       VALUES ('test',$1) RETURNING id`,
      [`Cliente livro ${sequence}`],
    );
    return { measure, buyerId: buyer.rows[0]!.id };
  }

  async function sale(options: {
    paymentStatus: 'paid' | 'pending';
    quantity?: number;
    price?: number;
    cost?: number;
  }) {
    const f = await fixture(5, options.cost ?? 20);
    const input = {
      environment: 'test' as const,
      customer_id: f.buyerId,
      items: [{
        measure: f.measure,
        quantity: options.quantity ?? 2,
        unit_price: options.price ?? 50,
      }],
      sold_at: '2026-07-10T14:00:00Z',
      payment_status: options.paymentStatus,
      due_date: options.paymentStatus === 'pending' ? '2026-08-10' : null,
      created_by: 'owner:wholesale-sale',
      idempotency_key: randomUUID(),
    };
    return { f, input, result: await registerSale(input, db.pool) };
  }

  it('venda paga registra receita e custo congelado sem duplicar', async () => {
    const created = await sale({ paymentStatus: 'paid' });
    expect(await registerSale(created.input, db.pool)).toEqual(created.result);

    const proof = await db.pool.query(
      `SELECT t.source_type,t.transaction_kind,t.amount::text,
              jsonb_object_agg(e.account_code,e.side ORDER BY e.line_no) entries
         FROM finance.matriz_ledger_transactions t
         JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id
        WHERE t.environment='test' AND t.source_id=$1
        GROUP BY t.id,t.source_type,t.transaction_kind,t.amount
        ORDER BY t.source_type`,
      [created.result.order_id],
    );
    expect(proof.rows).toEqual([
      {
        source_type: 'commerce.wholesale_order.cogs',
        transaction_kind: 'cost_of_goods_sold',
        amount: '40.00',
        entries: { cost_of_goods_sold: 'debit', inventory: 'credit' },
      },
      {
        source_type: 'commerce.wholesale_order.revenue',
        transaction_kind: 'sale_cash',
        amount: '100.00',
        entries: { cash: 'debit', sales_revenue: 'credit' },
      },
    ]);
  });

  it('venda fiada cria recebivel e a quitacao zera o saldo', async () => {
    const created = await sale({ paymentStatus: 'pending', quantity: 1, price: 80, cost: 30 });
    await settleSale(created.result.order_id, 'test', db.pool, {
      actor_label: 'owner:received', idempotency_key: randomUUID(),
    });

    const proof = await db.pool.query(
      `SELECT
         (SELECT array_agg(transaction_kind ORDER BY transaction_kind)
            FROM finance.matriz_ledger_transactions
           WHERE environment='test' AND source_id=$1) kinds,
         (SELECT count(*)::int FROM finance.matriz_ledger_payments p
            JOIN finance.matriz_ledger_transactions obligation
              ON obligation.id=p.obligation_transaction_id
           WHERE obligation.source_type='commerce.wholesale_order.revenue'
             AND obligation.source_id=$1) payments,
         (SELECT finance.matriz_ledger_obligation_balance('test',id)
            FROM finance.matriz_ledger_transactions
           WHERE environment='test'
             AND source_type='commerce.wholesale_order.revenue'
             AND source_id=$1) balance`,
      [created.result.order_id],
    );
    expect(proof.rows[0].kinds).toEqual(
      ['cost_of_goods_sold', 'payment', 'sale_receivable'],
    );
    expect(proof.rows[0].payments).toBe(1);
    expect(Number(proof.rows[0].balance)).toBe(0);
  });

  it('cancelamento nao recebido estorna receita e devolve custo ao estoque', async () => {
    const created = await sale({ paymentStatus: 'pending', quantity: 1, price: 70, cost: 25 });
    await cancelSale({
      environment: 'test', order_id: created.result.order_id,
      cancelled_by: 'owner:cancel', reason: 'Cliente desistiu antes de pagar',
      idempotency_key: randomUUID(),
    }, db.pool);

    const proof = await db.pool.query(
      `SELECT original.source_type,original.id,
              reversal.reversal_of_transaction_id
         FROM finance.matriz_ledger_transactions original
         JOIN finance.matriz_ledger_transactions reversal
           ON reversal.reversal_of_transaction_id=original.id
        WHERE original.environment='test' AND original.source_id=$1
        ORDER BY original.source_type`,
      [created.result.order_id],
    );
    expect(proof.rows).toHaveLength(2);
    expect(proof.rows.map((row) => row.source_type)).toEqual([
      'commerce.wholesale_order.cogs',
      'commerce.wholesale_order.revenue',
    ]);
    expect(proof.rows.every((row) => row.id === row.reversal_of_transaction_id)).toBe(true);
  });

  it('devolucao parcial recupera o custo da marca exata na mesma medida', async () => {
    sequence += 1;
    const measure = `${240 + sequence}/${35 + sequence}-${13 + sequence}`;
    const product = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.products
         (environment,product_code,product_name,product_type,brand)
       VALUES ('test',$1,$2,'tire','Pirelli') RETURNING id`,
      [`LEDGER-MB-${sequence}`, `Pneu multimarca ${sequence}`],
    );
    await db.pool.query(
      `INSERT INTO commerce.tire_specs
         (environment,product_id,tire_size,width_mm,aspect_ratio,rim_diameter)
       VALUES ('test',$1,$2,$3,$4,$5)`,
      [product.rows[0]!.id, measure, 240 + sequence, 35 + sequence, 13 + sequence],
    );
    await db.pool.query(
      `INSERT INTO commerce.wholesale_stock
         (environment,measure,brand,quantity_on_hand,unit_cost)
       VALUES ('test',$1,'Pirelli',2,10),('test',$1,'Metzeler',2,30)`,
      [measure],
    );
    const buyer = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.wholesale_customers (environment,name)
       VALUES ('test',$1) RETURNING id`,
      [`Cliente multimarca ${sequence}`],
    );
    const created = await registerSale({
      environment: 'test',
      customer_id: buyer.rows[0]!.id,
      items: [
        { measure, brand: 'Pirelli', quantity: 1, unit_price: 50 },
        { measure, brand: 'Metzeler', quantity: 1, unit_price: 50 },
      ],
      sold_at: '2026-07-10T14:00:00Z',
      payment_status: 'pending',
      due_date: '2026-08-10',
      created_by: 'owner:wholesale-sale',
      idempotency_key: randomUUID(),
    }, db.pool);

    await db.pool.query(
      `DELETE FROM commerce.wholesale_stock_movements
        WHERE environment='test' AND source='venda_atacado' AND ref=$1 AND brand='Metzeler'`,
      [created.order_id],
    );
    const cancelled = await cancelSale({
      environment: 'test', order_id: created.order_id,
      cancelled_by: 'owner:cancel', reason: 'Devolucao parcial comprovada',
      idempotency_key: randomUUID(),
    }, db.pool);

    expect(cancelled.stock_returned).toEqual([
      { measure, brand: 'Pirelli', quantity: 1 },
    ]);
    expect(cancelled.stock_unverified).toEqual([
      { measure, brand: 'Metzeler', quantity: 1 },
    ]);
    const proof = await db.pool.query(
      `SELECT t.amount::text,
              (SELECT jsonb_object_agg(e.account_code,e.side ORDER BY e.line_no)
                 FROM finance.matriz_ledger_entries e WHERE e.transaction_id=t.id) entries
         FROM finance.matriz_ledger_transactions t
        WHERE t.environment='test'
          AND t.source_type='commerce.wholesale_order.cogs_cancel' AND t.source_id=$1`,
      [created.order_id],
    );
    expect(proof.rows).toEqual([{
      amount: '10.00',
      entries: { cost_of_goods_sold: 'credit', inventory: 'debit' },
    }]);
  });

  it('cancelamento recebido preserva caixa e cria devolucao ao cliente', async () => {
    const created = await sale({ paymentStatus: 'paid', quantity: 1, price: 90, cost: 35 });
    await cancelSale({
      environment: 'test', order_id: created.result.order_id,
      cancelled_by: 'owner:cancel', reason: 'Venda paga cancelada',
      idempotency_key: randomUUID(),
    }, db.pool);

    const proof = await db.pool.query(
      `SELECT t.source_type,t.transaction_kind,t.reversal_of_transaction_id,
              jsonb_object_agg(e.account_code,e.side ORDER BY e.line_no) entries
         FROM finance.matriz_ledger_transactions t
         JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id
        WHERE t.environment='test' AND t.source_id=$1
        GROUP BY t.id,t.source_type,t.transaction_kind,t.reversal_of_transaction_id
        ORDER BY t.source_type`,
      [created.result.order_id],
    );
    expect(proof.rows).toEqual([
      {
        source_type: 'commerce.wholesale_order.cogs',
        transaction_kind: 'cost_of_goods_sold',
        reversal_of_transaction_id: null,
        entries: { cost_of_goods_sold: 'debit', inventory: 'credit' },
      },
      {
        source_type: 'commerce.wholesale_order.cogs_cancel',
        transaction_kind: 'reversal',
        reversal_of_transaction_id: expect.any(String),
        entries: { cost_of_goods_sold: 'credit', inventory: 'debit' },
      },
      {
        source_type: 'commerce.wholesale_order.revenue',
        transaction_kind: 'sale_cash',
        reversal_of_transaction_id: null,
        entries: { cash: 'debit', sales_revenue: 'credit' },
      },
      {
        source_type: 'commerce.wholesale_order.revenue_cancel',
        transaction_kind: 'customer_refund_payable',
        reversal_of_transaction_id: null,
        entries: { sales_returns: 'debit', customer_refund_payable: 'credit' },
      },
    ]);
  });
});
