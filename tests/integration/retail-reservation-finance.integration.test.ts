import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('reserva não é venda nem recebimento financeiro', () => {
  let db: IntegrationDb;
  let unitId: string;
  let productId: string;
  let sequence = 0;
  let retail: typeof import('../../src/admin/painel/matriz-ledger-retail-sales.js');
  let actions: typeof import('../../src/admin/painel/queries-pedidos-acoes.js');
  let reconciliation: typeof import('../../src/admin/painel/matriz-ledger-stage3-reconciliation.js');
  let report: typeof import('../../src/admin/painel/matriz-ledger-stage3-report.js');
  let reservation: typeof import('../../src/atendente-v2/matriz-stock-reservation.js');

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
      CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'test-token',
      MATRIZ_CENTRAL_LEDGER: 'true', WHOLESALE_MATRIZ_RETAIL_COST: 'true',
    });
    vi.resetModules();
    db = await startPostgres();
    retail = await import('../../src/admin/painel/matriz-ledger-retail-sales.js');
    actions = await import('../../src/admin/painel/queries-pedidos-acoes.js');
    reconciliation = await import('../../src/admin/painel/matriz-ledger-stage3-reconciliation.js');
    report = await import('../../src/admin/painel/matriz-ledger-stage3-report.js');
    reservation = await import('../../src/atendente-v2/matriz-stock-reservation.js');
    unitId = (await db.pool.query(`INSERT INTO core.units(environment,slug,name)
      VALUES('test','main','Matriz') ON CONFLICT(environment,slug) DO UPDATE SET is_active=true RETURNING id`)).rows[0].id;
    productId = (await db.pool.query(`INSERT INTO commerce.products
      (environment,product_code,product_name,product_type,brand,tire_condition)
      VALUES('test','FIN-RESERVA','Pneu financeiro reserva','tire','Sem marca','meia_vida') RETURNING id`)).rows[0].id;
    await db.pool.query(`INSERT INTO commerce.tire_specs(environment,product_id,tire_size)
      VALUES('test',$1,'130/70-13')`, [productId]);
    await db.pool.query(`INSERT INTO commerce.wholesale_stock
      (environment,measure,brand,tire_condition,quantity_on_hand,unit_cost)
      VALUES('test','130/70-13','Sem marca','meia_vida',100,25)`);
  }, 180_000);

  afterAll(async () => { if (db) await stopPostgres(db); });

  async function order(mode = 'pickup', status = 'open') {
    const contactId = (await db.pool.query(`INSERT INTO core.contacts
      (environment,chatwoot_contact_id,name) VALUES('test',$1,'Reserva teste') RETURNING id`,
    [987000 + ++sequence])).rows[0].id;
    const id = (await db.pool.query(`INSERT INTO commerce.orders
      (environment,contact_id,unit_id,total_amount,status,fulfillment_mode,payment_method,source,delivery_address)
      VALUES('test',$1,$2,89,$3,$4,'pix','chatwoot_com_bot',
        CASE WHEN $4='delivery' THEN 'Rua Teste, 10' END) RETURNING id`,
    [contactId, unitId, status, mode])).rows[0].id;
    await db.pool.query(`INSERT INTO commerce.order_items
      (environment,order_id,product_id,quantity,unit_price,matriz_unit_cost)
      VALUES('test',$1,$2,1,89,25)`, [id, productId]);
    return id as string;
  }

  async function reserve(id: string) {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await reservation.reserveMatrizGalpaoStock(client, 'test', id, [{ productId, quantity: 1 }], true);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async function ledgerCount(id: string) {
    return (await db.pool.query(`SELECT count(*)::int n FROM finance.matriz_ledger_transactions
      WHERE environment='test' AND source_id=$1`, [id])).rows[0].n;
  }

  it.each(['pickup', 'delivery'])('cancelar reserva %s preserva conciliação e reprocessar é inócuo', async mode => {
    const id = await order(mode);
    await reserve(id);
    await actions.cancelManualOrder({ environment: 'test', order_id: id,
      actor_label: 'test:reservation', reason: 'Desistência antes de realizar venda' }, db.pool);
    expect((await report.getMatrizStage3LedgerReconciliation('test', db.pool)).total_problems).toBe(0);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await reconciliation.runMatrizStage3LedgerBackfill({ environment: 'test' }, db.pool);
      expect(result.processed.retail_sales).toBe(0);
      expect(result.reconciliation.total_problems).toBe(0);
      expect(await ledgerCount(id)).toBe(0);
    }
    const stock = (await db.pool.query(`SELECT quantity_on_hand,quantity_reserved
      FROM commerce.wholesale_stock WHERE environment='test' AND measure='130/70-13'`)).rows[0];
    expect(stock).toEqual({ quantity_on_hand: 100, quantity_reserved: 0 });
  });

  it('pagamento direto de pedido cancelado não inventa receita nem entrada em caixa', async () => {
    const id = await order('pickup', 'cancelled');
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      expect(await retail.postMatrizRetailPaymentIfRealized(client, 'test', id)).toBeNull();
      await client.query('ROLLBACK');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    expect(await ledgerCount(id)).toBe(0);
  });

  it('reserva cancelada entre meses não gera divergência nas origens do Financeiro', async () => {
    const id = await order();
    await db.pool.query(`UPDATE commerce.orders SET created_at='2026-07-31T15:00:00-03:00',
      status='cancelled',updated_at='2026-08-01T15:00:00-03:00' WHERE id=$1`, [id]);
    const { getMatrizCentralLedgerFinancialTruth } = await import('../../src/admin/painel/matriz-ledger-financial-read.js');
    for (const month of ['2026-07', '2026-08']) {
      const result = await getMatrizCentralLedgerFinancialTruth('test', db.pool, month);
      expect(result.conciliacao.origens.find(row => row.origem === 'varejo')?.diferenca).toBe('0.00');
    }
  });

  it('retirada realizada em outro mês reconhece receita na data de retirada', async () => {
    const id = await order();
    await reserve(id);
    await db.pool.query(`UPDATE commerce.orders SET created_at='2026-07-01T15:00:00-03:00' WHERE id=$1`, [id]);
    await actions.completeMatrizPickup({ environment: 'test', order_id: id,
      actor_label: 'test:pickup', payment_method: 'pix' }, db.pool);
    const proof = (await db.pool.query(`SELECT t.competence_on::text,
      (o.retrieved_at AT TIME ZONE 'America/Sao_Paulo')::date::text retrieved_on
      FROM commerce.orders o JOIN finance.matriz_ledger_transactions t
        ON t.environment=o.environment AND t.source_id=o.id::text
      WHERE o.id=$1 AND t.source_type='commerce.order.revenue'`, [id])).rows[0];
    expect(proof.competence_on).toBe(proof.retrieved_on);
  });

  it('venda real sem receita ou baixa continua sendo detectada', async () => {
    await order('pickup', 'confirmed');
    const result = await report.getMatrizStage3LedgerReconciliation('test', db.pool);
    expect(result.missing.retail_revenue_missing).toBe(1);
    expect(result.missing.retail_stock_decrement_missing).toBe(1);
  });

  it('custo pendente de outro mês ou entrega pendente não reduz o resultado deste mês', async () => {
    const old = await order('pickup', 'confirmed');
    const pendingDelivery = await order('delivery', 'confirmed');
    await db.pool.query(`UPDATE commerce.order_items SET matriz_unit_cost=NULL WHERE order_id=ANY($1::uuid[])`,
      [[old, pendingDelivery]]);
    await db.pool.query(`UPDATE commerce.orders SET created_at='2026-07-01T15:00:00-03:00' WHERE id=$1`, [old]);
    const { getMatrizCentralLedgerFinancialTruth } = await import('../../src/admin/painel/matriz-ledger-financial-read.js');
    expect((await getMatrizCentralLedgerFinancialTruth('test', db.pool, '2026-08'))
      .competencia.receita_custo_pendente).toBe('0.00');
    expect((await getMatrizCentralLedgerFinancialTruth('test', db.pool, '2026-07'))
      .competencia.receita_custo_pendente).toBe('89.00');
    const state = await report.getMatrizStage3LedgerReconciliation('test', db.pool);
    expect(state.missing.retail_revenue_missing).toBe(2);
    expect(state.missing.retail_stock_decrement_missing).toBe(2);
  });

  it('cancelar venda já realizada sem lançamentos não esconde a inconsistência', async () => {
    const id = await order('pickup', 'confirmed');
    await actions.cancelManualOrder({ environment: 'test', order_id: id,
      actor_label: 'test:missing-sale', reason: 'Cancelamento de venda sem livro' }, db.pool);
    const state = await report.getMatrizStage3LedgerReconciliation('test', db.pool);
    expect(state.missing.retail_revenue_missing).toBe(3);
    expect(state.missing.retail_stock_decrement_missing).toBe(3);
  });
});
