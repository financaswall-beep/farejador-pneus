/**
 * Testes mínimos do Portal Parceiro — etapa 3 do plano de correção da auditoria
 * de 2026-05-21.
 *
 * Cobertura:
 *   1. Venda baixa estoque (decremento atômico)
 *   2. Estoque insuficiente retorna erro controlado (BUG #2 da 0042)
 *   3. Cancelamento restaura estoque
 *   4. Token revogado retorna 401
 *   5. Isolamento entre parceiros (3 sub-casos):
 *      5a. Token A lista vendas → não aparece venda da unidade B
 *      5b. Token A tenta cancelar pedido da unidade B → não-cancelled
 *      5c. Token A tenta vender usando partner_stock_id da unidade B → erro
 *
 * Cada teste usa fixtures isoladas (slug UUID-based) — não há cleanup entre
 * testes, mas como o banco é efêmero (testcontainers), tudo morre no afterAll.
 *
 * Não toca em bot/atendente/planner/organizadora.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres';
import { createPartnerFixture, getStockQty } from './helpers/partner-fixtures';
import type { PartnerContext } from '../../src/parceiro/auth.js';

let db: IntegrationDb;

beforeAll(async () => {
  db = await startPostgres();
  // Env vars necessárias antes de qualquer dynamic import de módulos do app
  process.env.DATABASE_URL = db.connectionString;
  process.env.FAREJADOR_ENV = 'test';
  process.env.NODE_ENV = 'test';
  process.env.CHATWOOT_HMAC_SECRET = 'test-secret-not-used-here';
  process.env.ADMIN_AUTH_TOKEN = 'admin-not-used-here-1234567890';
}, 180_000);

afterAll(async () => {
  if (db) await stopPostgres(db);
});

// --------------------------------------------------------------
// Helper: import dinâmico das queries, garantindo que env já está setado
// --------------------------------------------------------------
async function importQueries() {
  return import('../../src/parceiro/queries.js');
}

async function importAuth() {
  return import('../../src/parceiro/auth.js');
}

async function receivePurchase(ctx: PartnerContext, purchaseId: string): Promise<void> {
  const items = await db.pool.query<{ id: string; quantity: number }>(
    `SELECT id, quantity FROM commerce.partner_purchase_items
      WHERE purchase_id=$1 AND environment=$2 ORDER BY created_at`,
    [purchaseId, ctx.environment],
  );
  const operation = await import('../../src/parceiro/operation-purchase-receipt.js');
  await operation.receiveOperationPurchase(ctx, 'Fixture', purchaseId, {
    idempotency_key: `receipt-${randomUUID()}`,
    items: items.rows.map((item) => ({ item_id: item.id, received_quantity: Number(item.quantity) })),
  });
}

// Helper: factory de reply mock no estilo do tests/unit/admin/auth.test.ts
interface MockReply {
  statusCode: number;
  payload: unknown;
  status: (code: number) => MockReply;
  send: (payload: unknown) => MockReply;
}
function createMockReply(): MockReply {
  const reply: MockReply = {
    statusCode: 200,
    payload: undefined,
    status(code) { this.statusCode = code; return this; },
    send(payload) { this.payload = payload; return this; },
  };
  return reply;
}

// --------------------------------------------------------------
// 1. Venda baixa estoque
// --------------------------------------------------------------
describe('Portal Parceiro — venda baixa estoque', () => {
  it('serializa duplo clique simultâneo pela chave idempotente', async () => {
    const q = await importQueries();
    const f = await createPartnerFixture(db.pool, { initialStockQty: 10 });
    const idempotencyKey = `concurrent-sale-${randomUUID()}`;
    const input = {
      customer_name: 'Cliente Duplo Clique',
      customer_phone: null,
      items: [{ partner_stock_id: f.stockId, quantity: 2, unit_price: 100 }],
      payment_method: 'pix',
      fulfillment_mode: 'pickup' as const,
      source_tag: 'porta' as const,
      idempotency_key: idempotencyKey,
    };

    const [first, second] = await Promise.all([
      q.registerPartnerSale(f.ctx, input),
      q.registerPartnerSale(f.ctx, input),
    ]);

    expect(first.order_id).toBe(second.order_id);
    expect(await getStockQty(db.pool, f.stockId)).toBe(8);
    const orders = await db.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM commerce.partner_orders
        WHERE environment='test' AND unit_id=$1 AND idempotency_key=$2`,
      [f.unitId, idempotencyKey],
    );
    expect(orders.rows[0]?.count).toBe(1);
  });

  it('decrementa quantity_on_hand atomicamente ao registrar venda', async () => {
    const q = await importQueries();
    const f = await createPartnerFixture(db.pool, { initialStockQty: 10 });

    const result = await q.registerPartnerSale(f.ctx, {
      customer_name: 'Cliente Teste',
      customer_phone: null,
      items: [{
        partner_stock_id: f.stockId,
        quantity: 3,
        unit_price: 135,
        reference_unit_price: 150,
      }],
      payment_method: 'pix',
      fulfillment_mode: 'pickup',
      source_tag: 'porta',
      idempotency_key: `test-${randomUUID()}`,
    }, db.pool);

    expect(result.order_id).toBeTruthy();
    expect(await getStockQty(db.pool, f.stockId)).toBe(7);
    const prices = await db.pool.query<{
      total_amount: string; unit_price: string; reference_unit_price: string;
    }>(
      `SELECT po.total_amount::text,oi.unit_price::text,oi.reference_unit_price::text
         FROM commerce.partner_orders po
         JOIN commerce.partner_order_items oi
           ON oi.order_id=po.id AND oi.environment=po.environment
        WHERE po.id=$1`,
      [result.order_id],
    );
    expect(prices.rows[0]).toEqual({
      total_amount: '405.00', unit_price: '135.00', reference_unit_price: '150.00',
    });
  });

  it('emite 2 eventos audit: partner_order_created + stock_decrement_sale (BUG #5 da 0042)', async () => {
    const q = await importQueries();
    const f = await createPartnerFixture(db.pool, { initialStockQty: 5 });

    const result = await q.registerPartnerSale(f.ctx, {
      customer_name: 'Audit',
      customer_phone: null,
      items: [{ partner_stock_id: f.stockId, quantity: 1, unit_price: 100 }],
      payment_method: 'pix',
      fulfillment_mode: 'pickup',
      source_tag: 'porta',
      idempotency_key: `audit-${randomUUID()}`,
    }, db.pool);

    const audits = await db.pool.query<{ event_type: string }>(
      `SELECT event_type FROM audit.events WHERE entity_id = $1 ORDER BY event_type`,
      [result.order_id],
    );
    const types = audits.rows.map((r) => r.event_type);
    expect(types).toContain('partner_order_created');
    expect(types).toContain('stock_decrement_sale');
  });
});

describe('Portal Parceiro — realização financeira de entrega e retirada reservada', () => {
  it('não antecipa caixa e conta cada recebimento uma única vez ao finalizar', async () => {
    const q = await importQueries();
    const f = await createPartnerFixture(db.pool, { initialStockQty: 10 });
    const delivery = await q.registerPartnerSale(f.ctx, {
      customer_name: 'Cliente Entrega', customer_phone: null,
      items: [{ partner_stock_id: f.stockId, quantity: 1, unit_price: 120 }],
      payment_method: 'A receber', payment_status: 'receivable',
      fulfillment_mode: 'delivery', delivery_address: 'Rua Financeira, 10',
      source_tag: '2w', idempotency_key: `delivery-finance-${randomUUID()}`,
    });
    const pickupKey = `pickup-finance-${randomUUID()}`;
    const pickup = await db.pool.query<{ order_id: string }>(
      `SELECT commerce.register_partner_local_order(
         'test',$1,'Cliente Retirada',NULL,$2::jsonb,'A receber','pickup',NULL,
         'integration:finance',$3,'2w',0,0,true
       ) AS order_id`,
      [f.unitId, JSON.stringify([{
        partner_stock_id: f.stockId, quantity: 1, unit_price: 80,
      }]), pickupKey],
    );
    const pickupId = pickup.rows[0]!.order_id;

    const simple = await import('../../src/parceiro/simple-finance.js');
    const entries = await import('../../src/parceiro/finance-entries.js');
    let summary = await db.pool.query<{ sales_month: string; cash_in_month: string }>(
      `SELECT sales_month::text,cash_in_month::text
         FROM network.partner_unit_summary WHERE environment='test' AND unit_id=$1`,
      [f.unitId],
    );
    expect(summary.rows[0]).toMatchObject({ sales_month: '0', cash_in_month: '0' });
    expect((await simple.getPartnerSimpleFinance(f.ctx, 'today')).cash_in).toBe(0);
    expect((await entries.getPartnerFinanceEntries(f.ctx, 'today')).total).toBe(0);
    expect((await q.getPartnerRelatorioCaixa(f.ctx)).vendas_total).toBe(0);

    await q.updatePartnerDeliveryStatus(f.ctx, delivery.order_id, {
      delivery_status: 'delivered', payment_method: 'Pix', delivery_courier: 'Teste',
    });
    await q.markPartnerPickupRetrieved(f.ctx, pickupId, { payment_method: 'Dinheiro' });

    summary = await db.pool.query<{ sales_month: string; cash_in_month: string }>(
      `SELECT sales_month::text,cash_in_month::text
         FROM network.partner_unit_summary WHERE environment='test' AND unit_id=$1`,
      [f.unitId],
    );
    expect(summary.rows[0]).toMatchObject({ sales_month: '200.00', cash_in_month: '200.00' });
    const finance = await simple.getPartnerSimpleFinance(f.ctx, 'today');
    expect(finance.cash_in).toBe(200);
    const financeEntries = await entries.getPartnerFinanceEntries(f.ctx, 'today');
    expect(financeEntries.total).toBe(200);
    expect(financeEntries.count).toBe(2);
    expect((await q.getPartnerRelatorioCaixa(f.ctx)).vendas_total).toBe(200);
    const receivables = await db.pool.query<{ count: number; total: string }>(
      `SELECT count(*)::int AS count,COALESCE(sum(amount),0)::text AS total
         FROM finance.partner_receivables
        WHERE environment='test' AND unit_id=$1 AND status='received'`,
      [f.unitId],
    );
    expect(receivables.rows[0]).toMatchObject({ count: 2, total: '200.00' });
  });

  it('duplo clique concorrente na retirada baixa estoque e caixa uma única vez', async () => {
    const q = await importQueries();
    const f = await createPartnerFixture(db.pool, { initialStockQty: 6 });
    const pickup = await db.pool.query<{ order_id: string }>(
      `SELECT commerce.register_partner_local_order(
         'test',$1,'Cliente Duplo Clique',NULL,$2::jsonb,'A receber','pickup',NULL,
         'integration:pickup-race',$3,'2w',0,0,true
       ) AS order_id`,
      [f.unitId, JSON.stringify([{
        partner_stock_id: f.stockId, quantity: 2, unit_price: 40,
      }]), `pickup-race-${randomUUID()}`],
    );
    const pickupId = pickup.rows[0]!.order_id;

    const results = await Promise.allSettled([
      q.markPartnerPickupRetrieved(f.ctx, pickupId, { payment_method: 'Pix' }),
      q.markPartnerPickupRetrieved(f.ctx, pickupId, { payment_method: 'Pix' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);

    const state = await db.pool.query(
      `SELECT o.status,o.awaiting_pickup,s.quantity_on_hand,s.quantity_reserved,
        (SELECT count(*)::int FROM finance.partner_receivables r
          WHERE r.source_order_id=o.id AND r.status='received') receipts,
        (SELECT COALESCE(sum(amount),0)::text FROM finance.partner_receivables r
          WHERE r.source_order_id=o.id AND r.status='received') received_total,
        (SELECT count(*)::int FROM audit.events a WHERE a.entity_id=o.id
          AND a.event_type='partner_pickup_retrieved') audits
       FROM commerce.partner_orders o
       JOIN commerce.partner_stock_levels s ON s.id=$2
       WHERE o.id=$1`,
      [pickupId, f.stockId],
    );
    expect(state.rows[0]).toMatchObject({
      status: 'paid', awaiting_pickup: false, quantity_on_hand: 4,
      quantity_reserved: 0, receipts: 1, received_total: '80.00', audits: 1,
    });
  });

  it('cancelar retirada libera a reserva sem baixar o físico nem criar caixa', async () => {
    const q = await importQueries();
    const f = await createPartnerFixture(db.pool, { initialStockQty: 5 });
    const pickup = await db.pool.query<{ order_id: string }>(
      `SELECT commerce.register_partner_local_order(
         'test',$1,'Cliente Cancelou',NULL,$2::jsonb,'A receber','pickup',NULL,
         'integration:pickup-cancel',$3,'2w',0,0,true
       ) AS order_id`,
      [f.unitId, JSON.stringify([{
        partner_stock_id: f.stockId, quantity: 2, unit_price: 70,
      }]), `pickup-cancel-${randomUUID()}`],
    );
    const pickupId = pickup.rows[0]!.order_id;

    await expect(q.cancelPartnerSale(f.ctx, pickupId, 'Cliente não apareceu'))
      .resolves.toEqual({ order_id: pickupId, cancelled: true });

    const state = await db.pool.query(
      `SELECT o.status,s.quantity_on_hand,s.quantity_reserved,
        (SELECT count(*)::int FROM finance.partner_receivables r
          WHERE r.source_order_id=o.id AND r.status='received') receipts
       FROM commerce.partner_orders o
       JOIN commerce.partner_stock_levels s ON s.id=$2
       WHERE o.id=$1`,
      [pickupId, f.stockId],
    );
    expect(state.rows[0]).toMatchObject({
      status: 'cancelled', quantity_on_hand: 5, quantity_reserved: 0, receipts: 0,
    });
  });

  it('replay de entregue preserva data, pagamento, entregador e auditoria originais', async () => {
    const q = await importQueries();
    const f = await createPartnerFixture(db.pool, { initialStockQty: 5 });
    const sale = await q.registerPartnerSale(f.ctx, {
      customer_name: 'Cliente Replay', customer_phone: null,
      items: [{ partner_stock_id: f.stockId, quantity: 1, unit_price: 90 }],
      payment_method: 'A receber', payment_status: 'receivable',
      fulfillment_mode: 'delivery', delivery_address: 'Rua Replay, 10',
      source_tag: '2w', idempotency_key: `delivery-replay-${randomUUID()}`,
    });
    await q.updatePartnerDeliveryStatus(f.ctx, sale.order_id, {
      delivery_status: 'delivered', payment_method: 'Pix', delivery_courier: 'Ana',
    });
    const first = await db.pool.query(
      `SELECT o.delivery_courier,r.received_at,r.payment_method,
        (SELECT count(*)::int FROM audit.events a
          WHERE a.entity_id=o.id AND a.event_type='partner_delivery_status_changed') audits
       FROM commerce.partner_orders o
       JOIN finance.partner_receivables r ON r.source_order_id=o.id
      WHERE o.id=$1`, [sale.order_id],
    );

    await q.updatePartnerDeliveryStatus(f.ctx, sale.order_id, {
      delivery_status: 'delivered', payment_method: 'Dinheiro', delivery_courier: 'Bruno',
    });
    const replay = await db.pool.query(
      `SELECT o.delivery_courier,r.received_at,r.payment_method,
        (SELECT count(*)::int FROM audit.events a
          WHERE a.entity_id=o.id AND a.event_type='partner_delivery_status_changed') audits
       FROM commerce.partner_orders o
       JOIN finance.partner_receivables r ON r.source_order_id=o.id
      WHERE o.id=$1`, [sale.order_id],
    );
    expect(replay.rows[0]).toEqual(first.rows[0]);
    expect(replay.rows[0]).toMatchObject({
      delivery_courier: 'Ana', payment_method: 'Pix', audits: 1,
    });
  });

  it('falha preserva a reserva e só o retorno físico libera o estoque', async () => {
    const q = await importQueries();
    const f = await createPartnerFixture(db.pool, { initialStockQty: 5 });
    const sale = await q.registerPartnerSale(f.ctx, {
      customer_name: 'Cliente Retorno', customer_phone: null,
      items: [{ partner_stock_id: f.stockId, quantity: 2, unit_price: 75 }],
      payment_method: 'A receber', payment_status: 'receivable',
      fulfillment_mode: 'delivery', delivery_address: 'Rua Retorno, 20',
      source_tag: '2w', idempotency_key: `delivery-return-${randomUUID()}`,
    });
    await q.updatePartnerDeliveryStatus(f.ctx, sale.order_id, {
      delivery_status: 'dispatched', delivery_courier: 'Carla',
    });
    await q.updatePartnerDeliveryStatus(f.ctx, sale.order_id, {
      delivery_status: 'failed', delivery_courier: 'Carla', reason: 'Cliente recusou',
    });
    const reported = await db.pool.query(
      `SELECT o.status,o.delivery_status,s.quantity_on_hand,s.quantity_reserved,r.status receivable_status
         FROM commerce.partner_orders o
         JOIN commerce.partner_stock_levels s ON s.id=$2
         LEFT JOIN finance.partner_receivables r ON r.source_order_id=o.id AND r.deleted_at IS NULL
        WHERE o.id=$1`, [sale.order_id, f.stockId],
    );
    expect(reported.rows[0]).toMatchObject({
      status: 'confirmed', delivery_status: 'failed', quantity_on_hand: 5,
      quantity_reserved: 2, receivable_status: null,
    });
    await expect(q.updatePartnerDeliveryStatus(f.ctx, sale.order_id, {
      delivery_status: 'pending',
    })).rejects.toThrow('delivery_already_finalized');

    await q.confirmPartnerDeliveryReturn(f.ctx, sale.order_id, 'Pneus conferidos na loja');
    await expect(q.confirmPartnerDeliveryReturn(f.ctx, sale.order_id, 'replay'))
      .resolves.toEqual({ order_id: sale.order_id, return_confirmed: true });
    const returned = await db.pool.query(
      `SELECT o.status,o.delivery_status,s.quantity_on_hand,s.quantity_reserved,
        (SELECT count(*)::int FROM audit.events a WHERE a.entity_id=o.id
          AND a.event_type='partner_delivery_return_confirmed') return_audits
       FROM commerce.partner_orders o
       JOIN commerce.partner_stock_levels s ON s.id=$2
      WHERE o.id=$1`, [sale.order_id, f.stockId],
    );
    expect(returned.rows[0]).toMatchObject({
      status: 'cancelled', delivery_status: 'failed', quantity_on_hand: 5,
      quantity_reserved: 0, return_audits: 1,
    });
  });
});

describe('Portal Parceiro — invariantes monetárias e concorrência financeira', () => {
  it('recusa zero, negativos e frações menores que um centavo em toda entrada manual', async () => {
    const q = await importQueries();
    const f = await createPartnerFixture(db.pool);

    for (const amount of [0, -1, 1.001]) {
      await expect(q.registerPartnerExpense(f.ctx, {
        category: 'other', description: 'Valor inválido', amount,
        idempotency_key: `expense-invalid-${amount}-${randomUUID()}`,
      })).rejects.toThrow('partner_finance_amount_invalid');
      await expect(q.registerPartnerPayable(f.ctx, {
        description: 'Valor inválido', amount,
        idempotency_key: `payable-invalid-${amount}-${randomUUID()}`,
      })).rejects.toThrow('partner_finance_amount_invalid');
      await expect(q.registerPartnerReceivable(f.ctx, {
        description: 'Valor inválido', amount,
        idempotency_key: `receivable-invalid-${amount}-${randomUUID()}`,
      })).rejects.toThrow('partner_finance_amount_invalid');
    }
  });

  it('o banco também impede fatos financeiros novos com valor zero', async () => {
    const f = await createPartnerFixture(db.pool);
    await expect(db.pool.query(
      `INSERT INTO commerce.partner_orders
         (environment,unit_id,total_amount,idempotency_key)
       VALUES ('test',$1,0,$2)`,
      [f.unitId, `db-zero-order-${randomUUID()}`],
    )).rejects.toThrow(/partner_orders_total_positive_finance_check/);
    await expect(db.pool.query(
      `INSERT INTO finance.partner_expenses
         (environment,unit_id,category,description,amount,idempotency_key)
       VALUES ('test',$1,'other','Zero',0,$2)`,
      [f.unitId, `db-zero-expense-${randomUUID()}`],
    )).rejects.toThrow(/partner_expenses_amount_positive_finance_check/);
    await expect(db.pool.query(
      `INSERT INTO finance.partner_payables
         (environment,unit_id,description,amount,idempotency_key)
       VALUES ('test',$1,'Zero',0,$2)`,
      [f.unitId, `db-zero-payable-${randomUUID()}`],
    )).rejects.toThrow(/partner_payables_amount_positive_finance_check/);
    await expect(db.pool.query(
      `INSERT INTO finance.partner_receivables
         (environment,unit_id,description,amount,idempotency_key)
       VALUES ('test',$1,'Zero',0,$2)`,
      [f.unitId, `db-zero-receivable-${randomUUID()}`],
    )).rejects.toThrow(/partner_receivables_amount_positive_finance_check/);
  });

  it('duas baixas simultâneas geram somente um recebimento ou pagamento', async () => {
    const q = await importQueries();
    const f = await createPartnerFixture(db.pool);
    const payable = await q.registerPartnerPayable(f.ctx, {
      description: 'Conta concorrente', amount: 75,
      idempotency_key: `payable-concurrent-${randomUUID()}`,
    });
    const receivable = await q.registerPartnerReceivable(f.ctx, {
      description: 'Recebível concorrente', amount: 125,
      idempotency_key: `receivable-concurrent-${randomUUID()}`,
    });

    const payableResults = await Promise.all([
      q.settlePartnerPayable(f.ctx, payable.payable_id, { payment_method: 'Pix' }),
      q.settlePartnerPayable(f.ctx, payable.payable_id, { payment_method: 'Pix' }),
    ]);
    const receivableResults = await Promise.all([
      q.settlePartnerReceivable(f.ctx, receivable.receivable_id, { payment_method: 'Pix' }),
      q.settlePartnerReceivable(f.ctx, receivable.receivable_id, { payment_method: 'Pix' }),
    ]);

    expect(payableResults.filter((result) => result.paid)).toHaveLength(1);
    expect(receivableResults.filter((result) => result.received)).toHaveLength(1);
    const proof = await db.pool.query<{
      expense_count: number; payable_audit_count: number; receivable_audit_count: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM finance.partner_expenses
           WHERE source_payable_id=$1 AND deleted_at IS NULL) expense_count,
         (SELECT count(*)::int FROM audit.events
           WHERE entity_id=$1 AND event_type='partner_payable_paid') payable_audit_count,
         (SELECT count(*)::int FROM audit.events
           WHERE entity_id=$2 AND event_type='partner_receivable_received') receivable_audit_count`,
      [payable.payable_id, receivable.receivable_id],
    );
    expect(proof.rows[0]).toEqual({
      expense_count: 1, payable_audit_count: 1, receivable_audit_count: 1,
    });
  });
});

// --------------------------------------------------------------
// Etapa 6 — custo histórico imutável
// --------------------------------------------------------------
describe('Portal Parceiro — custo histórico da venda', () => {
  it('congela o custo do item e compra futura não reprecifica a venda passada', async () => {
    const q = await importQueries();
    const f = await createPartnerFixture(db.pool, { initialStockQty: 10 });

    const sale = await q.registerPartnerSale(f.ctx, {
      customer_name: 'Custo histórico',
      customer_phone: null,
      items: [{ partner_stock_id: f.stockId, quantity: 1, unit_price: 150 }],
      payment_method: 'pix',
      fulfillment_mode: 'pickup',
      source_tag: 'porta',
      idempotency_key: `cost-sale-${randomUUID()}`,
    }, db.pool);

    const before = await db.pool.query<{
      unit_cost_snapshot: string; cost_status: string; estimated_result_month: string;
    }>(
      `SELECT oi.unit_cost_snapshot, oi.cost_status, s.estimated_result_month
         FROM commerce.partner_order_items oi
         JOIN commerce.partner_orders po ON po.id=oi.order_id AND po.environment=oi.environment
         JOIN network.partner_unit_summary s ON s.unit_id=po.unit_id AND s.environment=po.environment
        WHERE oi.order_id=$1`,
      [sale.order_id],
    );
    expect(before.rows[0]).toMatchObject({
      unit_cost_snapshot: '80.00',
      cost_status: 'known',
      estimated_result_month: '70.00',
    });

    const purchase = await q.registerPartnerPurchase(f.ctx, {
      supplier_name: null,
      purchased_at: null,
      payment_method: 'pix',
      payment_status: 'paid_now',
      payable_due_date: null,
      notes: null,
      idempotency_key: `cost-purchase-${randomUUID()}`,
      items: [{
        product_id: null,
        item_name: f.stockItemName,
        tire_size: '90/90-18',
        brand: 'Michelin',
        tire_condition: 'meia_vida',
        quantity: 10,
        unit_cost: 120,
        sale_price: 150,
      }],
    }, db.pool);
    await receivePurchase(f.ctx, purchase.purchase_id);

    const after = await db.pool.query<{
      unit_cost_snapshot: string; average_cost: string; estimated_result_month: string;
    }>(
      `SELECT oi.unit_cost_snapshot, ps.average_cost, s.estimated_result_month
         FROM commerce.partner_order_items oi
         JOIN commerce.partner_orders po ON po.id=oi.order_id AND po.environment=oi.environment
         JOIN commerce.partner_stock_levels ps ON ps.id=oi.partner_stock_id
         JOIN network.partner_unit_summary s ON s.unit_id=po.unit_id AND s.environment=po.environment
        WHERE oi.order_id=$1`,
      [sale.order_id],
    );
    expect(after.rows[0]?.average_cost).not.toBe('80.00');
    expect(after.rows[0]?.unit_cost_snapshot).toBe('80.00');
    expect(after.rows[0]?.estimated_result_month).toBe('70.00');
  });

  it('marca custo ausente como pendente e não inventa lucro', async () => {
    const q = await importQueries();
    const f = await createPartnerFixture(db.pool, { initialStockQty: 3 });
    await db.pool.query('UPDATE commerce.partner_stock_levels SET average_cost=NULL WHERE id=$1', [f.stockId]);

    const sale = await q.registerPartnerSale(f.ctx, {
      customer_name: 'Custo pendente',
      customer_phone: null,
      items: [{ partner_stock_id: f.stockId, quantity: 1, unit_price: 150 }],
      payment_method: 'pix',
      fulfillment_mode: 'pickup',
      source_tag: 'porta',
      idempotency_key: `pending-cost-${randomUUID()}`,
    }, db.pool);

    const result = await db.pool.query<{
      id: string;
      unit_cost_snapshot: string | null; cost_status: string;
      estimated_result_month: string | null; pending_cost_items_month: number;
    }>(
      `SELECT oi.id, oi.unit_cost_snapshot, oi.cost_status, s.estimated_result_month,
              s.pending_cost_items_month
         FROM commerce.partner_order_items oi
         JOIN commerce.partner_orders po ON po.id=oi.order_id AND po.environment=oi.environment
         JOIN network.partner_unit_summary s ON s.unit_id=po.unit_id AND s.environment=po.environment
        WHERE oi.order_id=$1`,
      [sale.order_id],
    );
    expect(result.rows[0]).toMatchObject({
      unit_cost_snapshot: null,
      cost_status: 'pending',
      estimated_result_month: null,
      pending_cost_items_month: 1,
    });

    const admin = await import('../../src/admin/painel/queries-rede-custos.js');
    const key = `cost-reconcile-${randomUUID()}`;
    const reconciled = await admin.reconcilePartnerItemCost({
      item_id: result.rows[0]!.id, unit_cost: 42.5,
      reason: 'nota fiscal original conferida', evidence: 'NF fixture 123',
      actor_label: 'admin:test', idempotency_key: key, environment: 'test',
    }, db.pool);
    expect(reconciled).toMatchObject({ unit_cost_snapshot: '42.50', cost_status: 'known' });
    const replay = await admin.reconcilePartnerItemCost({
      item_id: result.rows[0]!.id, unit_cost: 42.5,
      reason: 'nota fiscal original conferida', evidence: 'NF fixture 123',
      actor_label: 'admin:test', idempotency_key: key, environment: 'test',
    }, db.pool);
    expect(replay).toMatchObject({ unit_cost_snapshot: '42.50', replayed: true });

    const after = await db.pool.query(
      `SELECT s.estimated_result_month,s.pending_cost_items_month,
              e.actor_label,e.payload_before,e.payload_after
         FROM commerce.partner_order_items oi
         JOIN commerce.partner_orders po ON po.id=oi.order_id AND po.environment=oi.environment
         JOIN network.partner_unit_summary s ON s.unit_id=po.unit_id AND s.environment=po.environment
         JOIN audit.events e ON e.entity_id=oi.id AND e.event_type='partner_item_cost_reconciled'
        WHERE oi.id=$1`, [result.rows[0]!.id]);
    expect(after.rows[0]).toMatchObject({ estimated_result_month: '107.50',
      pending_cost_items_month: 0, actor_label: 'admin:test' });
    expect(after.rows[0].payload_before.cost_status).toBe('pending');
    expect(after.rows[0].payload_after).toMatchObject({ reason: 'nota fiscal original conferida',
      evidence: 'NF fixture 123' });
  });

  it('cancela compra recebida retirando unidades e valor do custo médio', async () => {
    const q = await importQueries();
    const f = await createPartnerFixture(db.pool, { initialStockQty: 10 });
    const purchase = await q.registerPartnerPurchase(f.ctx, {
      supplier_name: null, payment_method: 'pix',
      payment_status: 'paid_now', idempotency_key: `reverse-purchase-${randomUUID()}`,
      items: [{
        item_name: f.stockItemName, tire_size: '90/90-18', brand: 'Michelin',
        tire_condition: 'meia_vida', quantity: 10, unit_cost: 120, sale_price: 150,
      }],
    });
    await receivePurchase(f.ctx, purchase.purchase_id);
    await q.registerPartnerSale(f.ctx, {
      customer_name: 'Venda entre compra e estorno',
      items: [{ partner_stock_id: f.stockId, quantity: 5, unit_price: 150 }],
      payment_method: 'pix', fulfillment_mode: 'pickup', source_tag: 'porta',
      idempotency_key: `reverse-sale-${randomUUID()}`,
    });

    const result = await q.deletePartnerPurchase(f.ctx, purchase.purchase_id);
    expect(result.deleted).toBe(true);
    expect(result.stock_moves[0]).toMatchObject({
      stock_id: f.stockId, quantity_delta: -10,
      previous_qty: 15, new_qty: 5,
      previous_average_cost: '100.000000', new_average_cost: '60.000000',
      reversed_value: '1200.000000', rounding_residual: '0.000000',
    });
    const stock = await db.pool.query<{
      quantity_on_hand: number; average_cost: string;
    }>(
      `SELECT quantity_on_hand,average_cost::text
         FROM commerce.partner_stock_levels WHERE id=$1`,
      [f.stockId],
    );
    expect(stock.rows[0]).toEqual({ quantity_on_hand: 5, average_cost: '60.000000' });
    const event = await db.pool.query<{ payload_after: Record<string, unknown> }>(
      `SELECT payload_after FROM audit.events
        WHERE environment='test' AND event_type='stock_decrement_purchase_cancel'
          AND payload_after->>'purchase_id'=$1`,
      [purchase.purchase_id],
    );
    expect(event.rows[0]?.payload_after).toMatchObject({ purchase_id: purchase.purchase_id });
  });

  it('impede alteração direta do snapshot depois da venda', async () => {
    const q = await importQueries();
    const f = await createPartnerFixture(db.pool);
    const sale = await q.registerPartnerSale(f.ctx, {
      customer_name: 'Imutável', customer_phone: null,
      items: [{ partner_stock_id: f.stockId, quantity: 1, unit_price: 150 }],
      payment_method: 'pix', fulfillment_mode: 'pickup', source_tag: 'porta',
      idempotency_key: `immutable-cost-${randomUUID()}`,
    }, db.pool);

    await expect(db.pool.query(
      `UPDATE commerce.partner_order_items SET unit_cost_snapshot=999 WHERE order_id=$1`,
      [sale.order_id],
    )).rejects.toThrow(/partner_order_item_cost_snapshot_immutable/);
  });
});

describe('Portal Parceiro - variantes por condicao', () => {
  it('separa saldo e custo, congela a venda e devolve a condicao exata', async () => {
    const q = await importQueries();
    const f = await createPartnerFixture(db.pool, { initialStockQty: 3 });
    const purchase = async (
      condition: 'novo' | 'remold',
      quantity: number,
      unitCost: number,
    ) => q.registerPartnerPurchase(f.ctx, {
      supplier_name: null,
      purchased_at: null,
      payment_method: 'pix',
      payment_status: 'paid_now' as const,
      payable_due_date: null,
      notes: null,
      idempotency_key: `condition-purchase-${randomUUID()}`,
      items: [{
        product_id: null,
        item_name: f.stockItemName,
        tire_size: '90/90-18',
        brand: 'Michelin',
        tire_condition: condition,
        quantity,
        unit_cost: unitCost,
        sale_price: condition === 'novo' ? 220 : 145,
      }],
    }, db.pool);

    await receivePurchase(f.ctx, (await purchase('novo', 10, 100)).purchase_id);
    await receivePurchase(f.ctx, (await purchase('novo', 5, 120)).purchase_id);
    await receivePurchase(f.ctx, (await purchase('remold', 4, 70)).purchase_id);

    const variants = await db.pool.query<{
      id: string; tire_condition: string; quantity_on_hand: number; average_cost: string;
    }>(
      `SELECT id,tire_condition,quantity_on_hand,average_cost::text
         FROM commerce.partner_stock_levels
        WHERE environment='test' AND unit_id=$1
          AND item_name=$2 AND tire_size='90/90-18' AND brand='Michelin'
        ORDER BY tire_condition`,
      [f.unitId, f.stockItemName],
    );
    expect(variants.rows.map(({ tire_condition, quantity_on_hand, average_cost }) => ({
      tire_condition, quantity_on_hand, average_cost,
    }))).toEqual([
      { tire_condition: 'meia_vida', quantity_on_hand: 3, average_cost: '80.000000' },
      { tire_condition: 'novo', quantity_on_hand: 15, average_cost: '106.666667' },
      { tire_condition: 'remold', quantity_on_hand: 4, average_cost: '70.000000' },
    ]);

    const newStock = variants.rows.find((row) => row.tire_condition === 'novo')!;
    const sale = await q.registerPartnerSale(f.ctx, {
      customer_name: 'Cliente condicao',
      customer_phone: null,
      items: [{ partner_stock_id: newStock.id, quantity: 2, unit_price: 220 }],
      payment_method: 'pix',
      fulfillment_mode: 'pickup',
      delivery_address: null,
      source_tag: 'porta',
      idempotency_key: `condition-sale-${randomUUID()}`,
    }, db.pool);
    expect(await getStockQty(db.pool, newStock.id)).toBe(13);
    expect(await getStockQty(db.pool, f.stockId)).toBe(3);
    const snapshot = await db.pool.query<{ tire_condition: string }>(
      `SELECT tire_condition FROM commerce.partner_order_items WHERE order_id=$1`,
      [sale.order_id],
    );
    expect(snapshot.rows[0]?.tire_condition).toBe('novo');

    expect((await q.cancelPartnerSale(f.ctx, sale.order_id)).cancelled).toBe(true);
    expect(await getStockQty(db.pool, newStock.id)).toBe(15);
    expect(await getStockQty(db.pool, f.stockId)).toBe(3);
  });
});

// --------------------------------------------------------------
// 2. Estoque insuficiente → erro controlado (BUG #2 da 0042)
// --------------------------------------------------------------
describe('Portal Parceiro — estoque insuficiente', () => {
  it('levanta erro "Estoque insuficiente" quando quantity > saldo', async () => {
    const q = await importQueries();
    const f = await createPartnerFixture(db.pool, { initialStockQty: 2 });

    await expect(
      q.registerPartnerSale(f.ctx, {
        customer_name: 'Sem Saldo',
        customer_phone: null,
        items: [{ partner_stock_id: f.stockId, quantity: 999, unit_price: 100 }],
        payment_method: 'pix',
        fulfillment_mode: 'pickup',
        source_tag: 'porta',
        idempotency_key: `insuf-${randomUUID()}`,
      }, db.pool),
    ).rejects.toThrow(/Estoque insuficiente/);

    // Estoque NÃO mudou
    expect(await getStockQty(db.pool, f.stockId)).toBe(2);
  });
});

// --------------------------------------------------------------
// 3. Cancelamento restaura estoque
// --------------------------------------------------------------
describe('Portal Parceiro — cancelamento restaura estoque', () => {
  it('restaura quantity_on_hand ao cancelar venda', async () => {
    const q = await importQueries();
    const f = await createPartnerFixture(db.pool, { initialStockQty: 8 });

    const sale = await q.registerPartnerSale(f.ctx, {
      customer_name: 'Pre Cancel',
      customer_phone: null,
      items: [{ partner_stock_id: f.stockId, quantity: 3, unit_price: 100 }],
      payment_method: 'pix',
      fulfillment_mode: 'pickup',
      source_tag: 'porta',
      idempotency_key: `cancel-${randomUUID()}`,
    }, db.pool);

    expect(await getStockQty(db.pool, f.stockId)).toBe(5);

    const cancel = await q.cancelPartnerSale(f.ctx, sale.order_id);
    expect(cancel.cancelled).toBe(true);
    expect(await getStockQty(db.pool, f.stockId)).toBe(8);
  });
});

// --------------------------------------------------------------
// 4. Token revogado → 401
// --------------------------------------------------------------
describe('Portal Parceiro — autenticação', () => {
  it('retorna 401 quando token foi revogado', async () => {
    const { requirePartnerAuth } = await importAuth();
    const f = await createPartnerFixture(db.pool, { revokeToken: true });

    const request = {
      headers: { authorization: `Bearer ${f.tokenPlain}` },
      params: { slug: f.slug },
    } as unknown as Parameters<typeof requirePartnerAuth>[0];

    const reply = createMockReply();
    await requirePartnerAuth(request, reply as unknown as FastifyReply);

    expect(reply.statusCode).toBe(401);
    expect(reply.payload).toEqual({ error: 'partner_unauthorized' });
  });

  it('retorna 401 quando token está errado', async () => {
    const { requirePartnerAuth } = await importAuth();
    const f = await createPartnerFixture(db.pool);

    const request = {
      headers: { authorization: 'Bearer token-errado-1234567890abcdef' },
      params: { slug: f.slug },
    } as unknown as Parameters<typeof requirePartnerAuth>[0];

    const reply = createMockReply();
    await requirePartnerAuth(request, reply as unknown as FastifyReply);

    expect(reply.statusCode).toBe(401);
  });

  it('aceita token válido e popula partnerContext', async () => {
    const { requirePartnerAuth } = await importAuth();
    const f = await createPartnerFixture(db.pool);

    const request = {
      headers: { authorization: `Bearer ${f.tokenPlain}` },
      params: { slug: f.slug },
      partnerContext: undefined,
    } as unknown as Parameters<typeof requirePartnerAuth>[0];

    const reply = createMockReply();
    await requirePartnerAuth(request, reply as unknown as FastifyReply);

    // Não chamou reply.status → request prosseguiu
    expect(reply.statusCode).toBe(200);
    // E o contexto foi populado com a unidade certa
    expect((request as any).partnerContext?.unitId).toBe(f.unitId);
    expect((request as any).partnerContext?.slug).toBe(f.slug);
  });
});

// --------------------------------------------------------------
// Etapa 4 — níveis dono/funcionário (requireOwner)
// --------------------------------------------------------------
describe('Portal Parceiro — autorização por papel (Etapa 4)', () => {
  it('token de dono traz role=owner e passa no requireOwner', async () => {
    const { requirePartnerAuth, requireOwner } = await importAuth();
    const f = await createPartnerFixture(db.pool, { role: 'owner' });

    const request = {
      headers: { authorization: `Bearer ${f.tokenPlain}` },
      params: { slug: f.slug },
      partnerContext: undefined,
    } as unknown as Parameters<typeof requirePartnerAuth>[0];

    const authReply = createMockReply();
    await requirePartnerAuth(request, authReply as unknown as FastifyReply);
    expect((request as any).partnerContext?.role).toBe('owner');

    // requireOwner não deve barrar o dono
    const ownerReply = createMockReply();
    await requireOwner(request, ownerReply as unknown as FastifyReply);
    expect(ownerReply.statusCode).toBe(200);
  });

  it('token de funcionário traz role=funcionario e leva 403 no requireOwner', async () => {
    const { requirePartnerAuth, requireOwner } = await importAuth();
    const f = await createPartnerFixture(db.pool, { role: 'funcionario' });

    const request = {
      headers: { authorization: `Bearer ${f.tokenPlain}` },
      params: { slug: f.slug },
      partnerContext: undefined,
    } as unknown as Parameters<typeof requirePartnerAuth>[0];

    // 1. autentica OK (funcionário é login válido)
    const authReply = createMockReply();
    await requirePartnerAuth(request, authReply as unknown as FastifyReply);
    expect(authReply.statusCode).toBe(200);
    expect((request as any).partnerContext?.role).toBe('funcionario');

    // 2. mas requireOwner barra com 403 (financeiro/config é só do dono)
    const ownerReply = createMockReply();
    await requireOwner(request, ownerReply as unknown as FastifyReply);
    expect(ownerReply.statusCode).toBe(403);
    expect(ownerReply.payload).toEqual({ error: 'partner_forbidden_owner_only' });
  });

  it('requireOwner sem contexto (não autenticado) retorna 401', async () => {
    const { requireOwner } = await importAuth();

    const request = { partnerContext: undefined } as unknown as Parameters<typeof requireOwner>[0];
    const reply = createMockReply();
    await requireOwner(request, reply as unknown as FastifyReply);

    expect(reply.statusCode).toBe(401);
  });
});

// --------------------------------------------------------------
// 6. S4 — normalizacao E.164 do telefone (auditoria 2026-05-21)
// --------------------------------------------------------------
describe('Portal Parceiro — normalizacao de telefone E.164 (S4)', () => {
  it('grava customer_phone em E.164 quando input vem com mascara', async () => {
    const q = await importQueries();
    const f = await createPartnerFixture(db.pool, { initialStockQty: 5 });

    const sale = await q.registerPartnerSale(f.ctx, {
      customer_name: 'Cliente',
      customer_phone: '(21) 99999-9999',
      items: [{ partner_stock_id: f.stockId, quantity: 1, unit_price: 100 }],
      payment_method: 'pix',
      fulfillment_mode: 'pickup',
      source_tag: 'porta',
      idempotency_key: `phone-mask-${randomUUID()}`,
    }, db.pool);

    const order = await db.pool.query<{ customer_phone: string }>(
      `SELECT customer_phone FROM commerce.partner_orders WHERE id = $1`,
      [sale.order_id],
    );
    expect(order.rows[0]?.customer_phone).toBe('+5521999999999');
  });

  it('aceita formato ja-em-E.164 sem dupla normalizacao', async () => {
    const q = await importQueries();
    const f = await createPartnerFixture(db.pool, { initialStockQty: 5 });

    const sale = await q.registerPartnerSale(f.ctx, {
      customer_name: 'Cliente',
      customer_phone: '+5521988887777',
      items: [{ partner_stock_id: f.stockId, quantity: 1, unit_price: 100 }],
      payment_method: 'pix',
      fulfillment_mode: 'pickup',
      source_tag: 'porta',
      idempotency_key: `phone-e164-${randomUUID()}`,
    }, db.pool);

    const order = await db.pool.query<{ customer_phone: string }>(
      `SELECT customer_phone FROM commerce.partner_orders WHERE id = $1`,
      [sale.order_id],
    );
    expect(order.rows[0]?.customer_phone).toBe('+5521988887777');
  });

  it('grava null quando phone e invalido (nao trava venda)', async () => {
    const q = await importQueries();
    const f = await createPartnerFixture(db.pool, { initialStockQty: 5 });

    const sale = await q.registerPartnerSale(f.ctx, {
      customer_name: 'Cliente',
      customer_phone: 'xyz',
      items: [{ partner_stock_id: f.stockId, quantity: 1, unit_price: 100 }],
      payment_method: 'pix',
      fulfillment_mode: 'pickup',
      source_tag: 'porta',
      idempotency_key: `phone-bad-${randomUUID()}`,
    }, db.pool);

    const order = await db.pool.query<{ customer_phone: string | null }>(
      `SELECT customer_phone FROM commerce.partner_orders WHERE id = $1`,
      [sale.order_id],
    );
    expect(order.rows[0]?.customer_phone).toBeNull();
  });
});

// --------------------------------------------------------------
// 7. S1 — timezone-aware da Rede da matriz (auditoria 2026-05-21)
// --------------------------------------------------------------
describe('Painel Admin Rede — timezone-aware (S1)', () => {
  it('getPainelRede com period=month nao quebra e retorna estrutura esperada', async () => {
    // O fix da S1 trocou JS Date local-time por SQL `now() AT TIME ZONE 'America/Sao_Paulo'`.
    // Esse teste so confirma que o SQL nao quebra e retorna o shape esperado.
    // Validacao do TZ propriamente dito exige mock de relogio — fora do escopo desta etapa.
    const f = await createPartnerFixture(db.pool, { initialStockQty: 5 });
    // Cria uma venda pra ter dado real no Resumo Rede
    const q = await importQueries();
    await q.registerPartnerSale(f.ctx, {
      customer_name: 'Cliente TZ',
      customer_phone: null,
      items: [{ partner_stock_id: f.stockId, quantity: 1, unit_price: 100 }],
      payment_method: 'pix',
      fulfillment_mode: 'pickup',
      source_tag: 'porta',
      idempotency_key: `tz-test-${randomUUID()}`,
    }, db.pool);

    // Forca env pro test, dynamic import do admin queries
    process.env.FAREJADOR_ENV = 'test';
    const { getPainelRede } = await import('../../src/admin/painel/queries.js');
    const rows = await getPainelRede('month', db.pool) as Array<Record<string, unknown>>;
    const ours = rows.find((r) => r.unit_id === f.unitId);
    expect(ours).toBeTruthy();
    expect(ours).toHaveProperty('sales_month');
    expect(ours).toHaveProperty('sales_series');
    expect(ours).toHaveProperty('order_series');
  });

  it('todos os periodos (today/7d/30d/month) executam sem erro de SQL', async () => {
    process.env.FAREJADOR_ENV = 'test';
    const { getPainelRede } = await import('../../src/admin/painel/queries.js');
    for (const period of ['today', '7d', '30d', 'month'] as const) {
      await expect(getPainelRede(period, db.pool)).resolves.toBeTruthy();
    }
  });
});

// --------------------------------------------------------------
// 5. Isolamento entre parceiros (3 sub-casos)
// --------------------------------------------------------------
describe('Portal Parceiro — isolamento entre parceiros', () => {
  it('5a: getPartnerVendas com ctx A não retorna venda da unidade B', async () => {
    const q = await importQueries();
    const a = await createPartnerFixture(db.pool, { slugSuffix: 'aa' + randomUUID().slice(0, 6) });
    const b = await createPartnerFixture(db.pool, { slugSuffix: 'bb' + randomUUID().slice(0, 6) });

    // B faz 1 venda
    const saleB = await q.registerPartnerSale(b.ctx, {
      customer_name: 'Cliente B',
      customer_phone: null,
      items: [{ partner_stock_id: b.stockId, quantity: 1, unit_price: 200 }],
      payment_method: 'pix',
      fulfillment_mode: 'pickup',
      source_tag: 'porta',
      idempotency_key: `iso-b-${randomUUID()}`,
    }, db.pool);

    // A lista suas vendas — não pode ver a venda de B
    const vendasA = await q.getPartnerVendas(a.ctx, db.pool) as Array<{ order_id: string }>;
    const idsA = vendasA.map((v) => v.order_id);
    expect(idsA).not.toContain(saleB.order_id);
    expect(vendasA).toHaveLength(0);
  });

  it('5b: cancelPartnerSale com ctx A em orderId de B retorna cancelled=false', async () => {
    const q = await importQueries();
    const a = await createPartnerFixture(db.pool, { slugSuffix: 'aa' + randomUUID().slice(0, 6) });
    const b = await createPartnerFixture(db.pool, { slugSuffix: 'bb' + randomUUID().slice(0, 6) });

    const saleB = await q.registerPartnerSale(b.ctx, {
      customer_name: 'Cliente B',
      customer_phone: null,
      items: [{ partner_stock_id: b.stockId, quantity: 1, unit_price: 200 }],
      payment_method: 'pix',
      fulfillment_mode: 'pickup',
      source_tag: 'porta',
      idempotency_key: `iso-b-cancel-${randomUUID()}`,
    }, db.pool);

    const qtyBBefore = await getStockQty(db.pool, b.stockId);

    const result = await q.cancelPartnerSale(a.ctx, saleB.order_id, db.pool);
    expect(result.cancelled).toBe(false);

    // Estoque de B não foi tocado (cancelamento não aconteceu)
    expect(await getStockQty(db.pool, b.stockId)).toBe(qtyBBefore);

    // Pedido de B continua confirmed (não cancelled)
    const order = await db.pool.query<{ status: string }>(
      `SELECT status FROM commerce.partner_orders WHERE id = $1`,
      [saleB.order_id],
    );
    expect(order.rows[0]?.status).toBe('confirmed');
  });

  it('5c: registerPartnerSale com ctx A usando partner_stock_id de B é bloqueado', async () => {
    const q = await importQueries();
    const a = await createPartnerFixture(db.pool, { slugSuffix: 'aa' + randomUUID().slice(0, 6) });
    const b = await createPartnerFixture(db.pool, { slugSuffix: 'bb' + randomUUID().slice(0, 6) });

    // A tenta vender item de B usando seu próprio ctx (unit_id = a.unitId)
    await expect(
      q.registerPartnerSale(a.ctx, {
        customer_name: 'Atacante',
        customer_phone: null,
        items: [{ partner_stock_id: b.stockId, quantity: 1, unit_price: 100 }],
        payment_method: 'pix',
        fulfillment_mode: 'pickup',
        source_tag: 'porta',
        idempotency_key: `iso-c-${randomUUID()}`,
      }, db.pool),
    ).rejects.toThrow(/Item de estoque nao pertence a esta unidade/);

    // Estoque de B intacto
    expect(await getStockQty(db.pool, b.stockId)).toBe(10);

    // A não criou nenhum pedido
    const ordersA = await db.pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM commerce.partner_orders WHERE unit_id = $1`,
      [a.unitId],
    );
    expect(ordersA.rows[0]?.c).toBe('0');
  });
});

// --------------------------------------------------------------
// 5d. IDOR/BOLA em customer_id de contas a receber
// --------------------------------------------------------------
describe('Portal Parceiro - escopo do cliente em contas a receber', () => {
  it('aceita cliente proprio e bloqueia cliente de outra unidade no create e update', async () => {
    const q = await importQueries();
    const a = await createPartnerFixture(db.pool, { slugSuffix: 'recv-a' + randomUUID().slice(0, 6) });
    const b = await createPartnerFixture(db.pool, { slugSuffix: 'recv-b' + randomUUID().slice(0, 6) });

    const ownCustomer = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.partner_customers (environment, unit_id, name)
       VALUES ('test', $1, 'Cliente A') RETURNING id`,
      [a.unitId],
    );
    const foreignCustomer = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.partner_customers (environment, unit_id, name)
       VALUES ('test', $1, 'Cliente B') RETURNING id`,
      [b.unitId],
    );
    const ownCustomerId = ownCustomer.rows[0]!.id;
    const foreignCustomerId = foreignCustomer.rows[0]!.id;

    const created = await q.registerPartnerReceivable(a.ctx, {
      customer_id: ownCustomerId,
      customer_name: 'Cliente A',
      description: 'Conta valida da unidade A',
      amount: 150,
      due_date: '2026-08-15',
      status: 'open',
      idempotency_key: `recv-own-${randomUUID()}`,
    });

    await expect(q.registerPartnerReceivable(a.ctx, {
      customer_id: foreignCustomerId,
      customer_name: 'Cliente B',
      description: 'Tentativa cross-unit no create',
      amount: 200,
      due_date: '2026-08-16',
      status: 'open',
      idempotency_key: `recv-cross-create-${randomUUID()}`,
    })).rejects.toThrow('customer_not_found');

    await expect(q.updatePartnerReceivable(a.ctx, created.receivable_id, {
      customer_id: foreignCustomerId,
      customer_name: 'Cliente B',
      description: 'Tentativa cross-unit no update',
      amount: 250,
      due_date: '2026-08-17',
    })).rejects.toThrow('customer_not_found');

    const persisted = await db.pool.query<{ customer_id: string }>(
      `SELECT customer_id
         FROM finance.partner_receivables
        WHERE id = $1 AND environment = 'test' AND unit_id = $2`,
      [created.receivable_id, a.unitId],
    );
    expect(persisted.rows[0]?.customer_id).toBe(ownCustomerId);

    await expect(q.registerPartnerReceivable(a.ctx, {
      customer_id: null,
      customer_name: 'Lancamento avulso',
      description: 'Conta sem cadastro de cliente',
      amount: 50,
      due_date: '2026-08-18',
      status: 'open',
      idempotency_key: `recv-null-${randomUUID()}`,
    })).resolves.toHaveProperty('receivable_id');
  });
});

// --------------------------------------------------------------
// 6. Raio de entrega (proximidade-primeiro, Fase 2) — round-trip
// --------------------------------------------------------------
describe('Portal Parceiro — raio de entrega (Fase 2)', () => {
  it('grava e relê delivery_radius_km; pickup zera o raio (NULL)', async () => {
    const q = await importQueries();
    const fx = await createPartnerFixture(db.pool, { slugSuffix: 'raio' + randomUUID().slice(0, 6) });

    // Faz entrega com raio → persiste o número.
    await q.updatePartnerAtendimento(fx.ctx, 'delivery', 8.5);
    let cfg = await q.getPartnerConfiguracoes(fx.ctx);
    expect(cfg.loja?.delivery_radius_km).toBe(8.5);
    expect(cfg.loja?.faz_entrega).toBe(true);

    // Both com outro raio → sobrescreve.
    await q.updatePartnerAtendimento(fx.ctx, 'both', 12);
    cfg = await q.getPartnerConfiguracoes(fx.ctx);
    expect(cfg.loja?.delivery_radius_km).toBe(12);

    // Não faz entrega (pickup) → raio NULL (não há o que limitar).
    await q.updatePartnerAtendimento(fx.ctx, 'pickup', null);
    cfg = await q.getPartnerConfiguracoes(fx.ctx);
    expect(cfg.loja?.delivery_radius_km).toBeNull();
    expect(cfg.loja?.faz_entrega).toBe(false);
  });
});
