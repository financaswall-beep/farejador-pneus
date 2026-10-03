import { futureDueDate } from './helpers/business-dates.js';
// AUDITORIA 02/10/2026 - MODELO (ja passa): lado do parceiro faz a corrida certa.
// Mover para tests/integration/ JUNTO com o conserto do item (ver docs/PLANO_CORRECOES_AUDITORIA_2026-10-02.md).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPartnerFixture } from './helpers/partner-fixtures.js';
import { buildRestrictedConnectionString, startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('auditoria: parceiro, fiado cancelado enquanto recebe uma parte', () => {
  let db: IntegrationDb;
  beforeAll(async () => {
    Object.assign(process.env, { NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
      CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'emergency-token' });
    db = await startPostgres();
    process.env.DATABASE_URL = db.connectionString;
    process.env.PARTNER_DATABASE_URL = buildRestrictedConnectionString(db.connectionString);
    vi.resetModules();
  }, 240_000);
  afterAll(async () => {
    const { partnerPool } = await import('../../src/parceiro/db.js');
    await partnerPool.end().catch(() => undefined);
    if (db) await stopPostgres(db);
  });

  it('pagamento parcial commitado no meio do cancelamento vira devolucao, nunca some', async () => {
    const fx = await createPartnerFixture(db.pool, { slugSuffix: 'corrida', initialStockQty: 5 });
    const partner = await import('../../src/parceiro/queries.js');
    const events = await import('../../src/parceiro/partner-receivable-events.js');
    const sale = await partner.registerPartnerSale(fx.ctx, {
      customer_name: 'Cliente fiado', customer_phone: null,
      items: [{ partner_stock_id: fx.stockId, quantity: 1, unit_price: 150 }],
      payment_method: 'A receber', payment_status: 'receivable', receivable_due_date: futureDueDate(),
      fulfillment_mode: 'pickup', delivery_address: null, source_tag: 'porta', idempotency_key: randomUUID(),
    } as never, db.pool);
    const receivable = (await db.pool.query(`SELECT id,amount::text FROM finance.partner_receivables WHERE source_order_id=$1`, [sale.order_id])).rows[0];
    // Sequencial primeiro: recebe 60 e depois cancela (o certo).
    // Corrida: o recebimento de 60 segura a linha do titulo, o cancelamento comeca e espera, o recebimento commita.
    const holder = await db.pool.connect();
    await holder.query('BEGIN');
    await holder.query(`SELECT id FROM finance.partner_receivables WHERE id=$1 FOR UPDATE`, [receivable.id]);
    await holder.query(`INSERT INTO finance.partner_receivable_events
        (environment,unit_id,receivable_id,event_kind,amount,occurred_at,payment_method,idempotency_key,created_by)
      VALUES ('test',$1,$2,'receipt',60,now(),'Pix',$3,'auditoria')`, [fx.unitId, receivable.id, `race-${randomUUID()}`]);
    const cancel = partner.cancelPartnerSale(fx.ctx, sale.order_id, 'cliente desistiu')
      .then((r) => `cancelou=${r.cancelled}`, (e: Error) => `erro: ${e.message}`);
    await new Promise((r) => setTimeout(r, 800));
    await holder.query('COMMIT'); holder.release();
    const outcome = await cancel;
    const rows = (await db.pool.query(`SELECT event_kind,amount::text FROM finance.partner_receivable_events
      WHERE receivable_id=$1 ORDER BY created_at`, [receivable.id])).rows;
    const recv = (await db.pool.query(`SELECT status,deleted_at IS NOT NULL apagado FROM finance.partner_receivables WHERE id=$1`, [receivable.id])).rows[0];
    console.log('PARCEIRO CORRIDA:', JSON.stringify({ outcome, titulo: receivable.amount, eventos: rows, recebivel: recv }));
    // Recebeu 60 de verdade e cancelou: os 60 precisam virar devolucao ao cliente.
    expect.soft(rows.filter((r: { event_kind: string }) => r.event_kind === 'refund').map((r: { amount: string }) => r.amount)).toEqual(['60.00']);
    void events;
  });
});
