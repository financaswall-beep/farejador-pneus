import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RegisterWalkinOrderInput } from '../../src/admin/painel/queries-pedidos.js';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('Etapa 3 — varejo da Matriz no livro central', () => {
  let db: IntegrationDb;
  let mainUnitId: string;
  let sequence = 0;
  let registerWalkin: typeof import(
    '../../src/admin/painel/queries-pedidos-acoes.js'
  ).registerWalkinOrder;
  let registerManual: typeof import(
    '../../src/admin/painel/queries-pedidos-acoes.js'
  ).registerManualOrder;
  let cancelOrder: typeof import(
    '../../src/admin/painel/queries-pedidos-acoes.js'
  ).cancelManualOrder;
  let setDelivery: typeof import(
    '../../src/admin/painel/queries-logistica.js'
  ).setMatrizDeliveryStatus;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
      CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'emergency-token',
      MATRIZ_CENTRAL_LEDGER: 'true', WHOLESALE_MATRIZ_RETAIL_COST: 'true',
    });
    vi.resetModules();
    db = await startPostgres();
    ({
      registerWalkinOrder: registerWalkin,
      registerManualOrder: registerManual,
      cancelManualOrder: cancelOrder,
    }
      = await import('../../src/admin/painel/queries-pedidos-acoes.js'));
    ({ setMatrizDeliveryStatus: setDelivery }
      = await import('../../src/admin/painel/queries-logistica.js'));
    await db.pool.query(
      `INSERT INTO core.units (environment,slug,name,is_active)
       VALUES ('test','main','Matriz livro varejo',true)
       ON CONFLICT (environment,slug) DO UPDATE SET is_active=true`,
    );
    const unit = await db.pool.query<{ id: string }>(
      `SELECT id FROM core.units WHERE environment='test' AND slug='main'`,
    );
    mainUnitId = unit.rows[0]!.id;
  }, 180_000);

  afterAll(async () => {
    if (db) await stopPostgres(db);
    process.env.MATRIZ_CENTRAL_LEDGER = 'false';
  });

  async function fixture(cost = 40, price = 60) {
    sequence += 1;
    const measure = `${270 + sequence}/${30 + sequence}-${14 + sequence}`;
    const product = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.products
         (environment,product_code,product_name,product_type)
       VALUES ('test',$1,$2,'tire') RETURNING id`,
      [`LEDGER-R-${sequence}`, `Pneu varejo livro ${sequence}`],
    );
    await db.pool.query(
      `INSERT INTO commerce.tire_specs (environment,product_id,tire_size)
       VALUES ('test',$1,$2)`,
      [product.rows[0]!.id, measure],
    );
    await db.pool.query(
      `INSERT INTO commerce.wholesale_stock
         (environment,measure,quantity_on_hand,unit_cost)
       VALUES ('test',$1,5,$2)`,
      [measure, cost],
    );
    await db.pool.query(
      `INSERT INTO commerce.matriz_product_prices
         (environment,product_id,price_amount,currency,valid_from)
       VALUES ('test',$1,$2,'BRL','2026-01-01T00:00:00Z')`,
      [product.rows[0]!.id, price],
    );
    return { productId: product.rows[0]!.id, measure };
  }

  function input(
    productId: string,
    paymentMethod: string,
    fulfillmentMode: 'pickup' | 'delivery' = 'pickup',
  ): RegisterWalkinOrderInput {
    sequence += 1;
    return {
      environment: 'test', customer_name: `Cliente varejo ${sequence}`,
      customer_phone: null, unit_id: mainUnitId,
      items: [{
        product_id: productId, quantity: 2, unit_price: 60, discount_amount: 10,
      }],
      payment_method: paymentMethod, fulfillment_mode: fulfillmentMode,
      payment_due_on: paymentMethod.toLowerCase() === 'a receber' ? '2026-08-15' : null,
      delivery_address: fulfillmentMode === 'delivery' ? 'Rua Teste, 10' : null,
      actor_label: 'owner:retail', seller_collaborator_id: null,
      idempotency_key: `retail-ledger-${Date.now()}-${sequence}`,
      source_tag: 'walkin_balcao',
    };
  }

  it('balcao pago registra receita e custo congelado', async () => {
    const f = await fixture(35);
    const sale = await registerWalkin(input(f.productId, 'pix'), db.pool);
    const proof = await db.pool.query(
      `SELECT t.source_type,t.transaction_kind,t.amount::text,
              jsonb_object_agg(e.account_code,e.side ORDER BY e.line_no) entries
         FROM finance.matriz_ledger_transactions t
         JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id
        WHERE t.environment='test' AND t.source_id=$1
        GROUP BY t.id,t.source_type,t.transaction_kind,t.amount
        ORDER BY t.source_type`,
      [sale.order_id],
    );
    expect(proof.rows).toEqual([
      {
        source_type: 'commerce.order.cogs',
        transaction_kind: 'cost_of_goods_sold',
        amount: '70.00',
        entries: { cost_of_goods_sold: 'debit', inventory: 'credit' },
      },
      {
        source_type: 'commerce.order.revenue',
        transaction_kind: 'sale_cash',
        amount: '110.00',
        entries: { cash: 'debit', sales_revenue: 'credit' },
      },
    ]);
  });

  it('venda manual da Matriz baixa estoque e reconhece o custo', async () => {
    const f = await fixture(32, 70);
    const contact = await db.pool.query<{ id: string }>(
      `INSERT INTO core.contacts (environment,chatwoot_contact_id,name)
       VALUES ('test',$1,'Cliente manual livro') RETURNING id`,
      [700_000 + sequence],
    );
    const conversation = await db.pool.query<{ id: string }>(
      `INSERT INTO core.conversations
         (environment,chatwoot_conversation_id,chatwoot_account_id,contact_id,
          current_status,started_at)
       VALUES ('test',$1,1,$2,'open',now()) RETURNING id`,
      [800_000 + sequence, contact.rows[0]!.id],
    );
    const sale = await registerManual({
      environment: 'test', contact_id: contact.rows[0]!.id,
      conversation_id: conversation.rows[0]!.id, unit_id: mainUnitId,
      items: [{ product_id: f.productId, quantity: 2, unit_price: 70 }],
      payment_method: 'pix', fulfillment_mode: 'pickup',
      actor_label: 'owner:manual', idempotency_key: `manual-ledger-${Date.now()}-${sequence}`,
      source_tag: 'chatwoot_sem_bot',
    }, db.pool);

    const proof = await db.pool.query(
      `SELECT
         (SELECT quantity_on_hand FROM commerce.wholesale_stock
           WHERE environment='test' AND measure=$1) stock,
         (SELECT count(*)::int FROM audit.events
           WHERE environment='test' AND entity_id=$2::uuid
             AND event_type='matriz_galpao_decrement') decrements,
         (SELECT amount::text FROM finance.matriz_ledger_transactions
           WHERE environment='test' AND source_type='commerce.order.cogs'
             AND source_id=$2::text) cogs`,
      [f.measure, sale.order_id],
    );
    expect(proof.rows[0]).toEqual({ stock: 3, decrements: 1, cogs: '64.00' });
  });

  it('venda a receber cancelada estorna receita e custo integralmente', async () => {
    const f = await fixture(25);
    const sale = await registerWalkin(input(f.productId, 'a receber'), db.pool);
    await cancelOrder({
      environment: 'test', order_id: sale.order_id,
      actor_label: 'owner:cancel', reason: 'Cliente desistiu antes de pagar',
    }, db.pool);
    const proof = await db.pool.query(
      `SELECT original.source_type,original.id,reversal.reversal_of_transaction_id
         FROM finance.matriz_ledger_transactions original
         JOIN finance.matriz_ledger_transactions reversal
           ON reversal.reversal_of_transaction_id=original.id
        WHERE original.environment='test' AND original.source_id=$1
        ORDER BY original.source_type`,
      [sale.order_id],
    );
    expect(proof.rows).toHaveLength(2);
    expect(proof.rows.every((row) => row.id === row.reversal_of_transaction_id)).toBe(true);
  });

  it('venda paga cancelada preserva caixa e cria devolucao ao cliente', async () => {
    const f = await fixture(30);
    const sale = await registerWalkin(input(f.productId, 'dinheiro'), db.pool);
    await cancelOrder({
      environment: 'test', order_id: sale.order_id,
      actor_label: 'owner:cancel', reason: 'Venda paga cancelada',
    }, db.pool);
    const cancellation = await db.pool.query(
      `SELECT t.transaction_kind,t.reversal_of_transaction_id,
              jsonb_object_agg(e.account_code,e.side ORDER BY e.line_no) entries
         FROM finance.matriz_ledger_transactions t
         JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id
        WHERE t.environment='test'
          AND t.source_type='commerce.order.revenue_cancel'
          AND t.source_id=$1
        GROUP BY t.id`,
      [sale.order_id],
    );
    expect(cancellation.rows[0]).toEqual({
      transaction_kind: 'customer_refund_payable',
      reversal_of_transaction_id: null,
      entries: { sales_returns: 'debit', customer_refund_payable: 'credit' },
    });
    const { getMatrizLedgerOpenItems } =
      await import('../../src/admin/painel/matriz-ledger-open-items.js');
    const { settleMatrizLedgerOpenItem } =
      await import('../../src/admin/painel/matriz-ledger-settlement.js');
    const refund = (await getMatrizLedgerOpenItems('test', db.pool)).a_pagar.itens
      .find((item) => item.tipo === 'devolucao_cliente' && item.id === sale.order_id);
    expect(refund?.valor).toBe('110.00');
    await settleMatrizLedgerOpenItem({
      obligation_id: refund!.obligation_id!,
      idempotency_key: randomUUID(), actor_label: 'owner:customer-refund',
      environment: 'test',
    }, db.pool);
    expect((await getMatrizLedgerOpenItems('test', db.pool)).a_pagar.itens.find(
      (item) => item.obligation_id === refund!.obligation_id,
    )).toBeUndefined();
  });

  it('varejo a receber aceita baixa parcial e sincroniza a origem ao quitar', async () => {
    const f = await fixture(22);
    const sale = await registerWalkin(input(f.productId, 'a receber'), db.pool);
    const { getMatrizLedgerOpenItems } =
      await import('../../src/admin/painel/matriz-ledger-open-items.js');
    const { settleMatrizLedgerOpenItem } =
      await import('../../src/admin/painel/matriz-ledger-settlement.js');
    const item = (await getMatrizLedgerOpenItems('test', db.pool)).a_receber.itens
      .find((row) => row.tipo === 'varejo' && row.id === sale.order_id);
    expect(item).toMatchObject({
      valor: '110.00',
      due_date: '2026-08-15',
      settlement_mode: 'retail_sale',
    });
    await settleMatrizLedgerOpenItem({
      obligation_id: item!.obligation_id!, amount: 40,
      idempotency_key: randomUUID(), actor_label: 'owner:retail-partial',
      environment: 'test',
    }, db.pool);
    expect((await getMatrizLedgerOpenItems('test', db.pool)).a_receber.itens.find(
      (row) => row.id === sale.order_id,
    )?.valor).toBe('70.00');
    await settleMatrizLedgerOpenItem({
      obligation_id: item!.obligation_id!, amount: 70, payment_method: 'pix',
      idempotency_key: randomUUID(), actor_label: 'owner:retail-final',
      environment: 'test',
    }, db.pool);
    const proof = await db.pool.query(
      `SELECT o.payment_method,
              finance.matriz_ledger_obligation_balance('test',t.id) balance
         FROM commerce.orders o
         JOIN finance.matriz_ledger_transactions t
           ON t.environment=o.environment
          AND t.source_type='commerce.order.revenue' AND t.source_id=o.id::text
        WHERE o.environment='test' AND o.id=$1`,
      [sale.order_id],
    );
    expect(proof.rows[0]).toMatchObject({ payment_method: 'pix' });
    expect(Number(proof.rows[0].balance)).toBe(0);
  });

  it('entrega nasce como recebivel e so vira caixa ao ser entregue', async () => {
    const f = await fixture(20);
    const sale = await registerWalkin(input(f.productId, 'dinheiro', 'delivery'), db.pool);
    const before = await db.pool.query<{ transaction_kind: string }>(
      `SELECT transaction_kind FROM finance.matriz_ledger_transactions
        WHERE environment='test' AND source_type='commerce.order.revenue' AND source_id=$1`,
      [sale.order_id],
    );
    expect(before.rows[0]!.transaction_kind).toBe('sale_receivable');

    await setDelivery({
      environment: 'test', order_id: sale.order_id,
      status: 'delivered', courier: 'Entregador Teste', payment_method: 'dinheiro',
    }, db.pool);
    const after = await db.pool.query(
      `SELECT
         (SELECT count(*)::int FROM finance.matriz_ledger_payments p
            JOIN finance.matriz_ledger_transactions obligation
              ON obligation.id=p.obligation_transaction_id
           WHERE obligation.source_type='commerce.order.revenue'
             AND obligation.source_id=$1) payments,
         (SELECT finance.matriz_ledger_obligation_balance('test',id)
            FROM finance.matriz_ledger_transactions
           WHERE environment='test' AND source_type='commerce.order.revenue'
             AND source_id=$1) balance`,
      [sale.order_id],
    );
    expect(after.rows[0].payments).toBe(1);
    expect(Number(after.rows[0].balance)).toBe(0);
  });
});
