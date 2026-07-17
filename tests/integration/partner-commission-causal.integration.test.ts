import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  buildRestrictedConnectionString, startPostgres, stopPostgres, type IntegrationDb,
} from './helpers/postgres';
import { createPartnerFixture } from './helpers/partner-fixtures';

let db: IntegrationDb;

beforeAll(async () => {
  db = await startPostgres();
  process.env.DATABASE_URL = db.connectionString;
  process.env.FAREJADOR_ENV = 'test';
  process.env.NODE_ENV = 'test';
  process.env.CHATWOOT_HMAC_SECRET = 'test-secret';
  process.env.ADMIN_AUTH_TOKEN = 'admin-test-token-1234567890';
}, 180_000);

afterAll(async () => { if (db) await stopPostgres(db); });

describe('Etapa 6 — livro causal de comissão 2W', () => {
  it('congela percentual na realização, liquida com retry e estorna sem apagar', async () => {
    const partner = await import('../../src/parceiro/queries.js');
    const admin = await import('../../src/admin/painel/queries.js');
    const f = await createPartnerFixture(db.pool, { initialStockQty: 5 });
    await db.pool.query('UPDATE network.partners SET commission_percent=5 WHERE id=$1', [f.partnerId]);

    const sale = await partner.registerPartnerSale(f.ctx, {
      customer_name: 'Cliente 2W', customer_phone: null,
      items: [{ partner_stock_id: f.stockId, quantity: 1, unit_price: 200 }],
      payment_method: 'A receber', fulfillment_mode: 'delivery',
      delivery_address: 'Rua Teste, 1', source_tag: '2w',
      idempotency_key: `commission-sale-${randomUUID()}`,
    }, db.pool);
    let count = await db.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM network.commission_entries WHERE partner_order_id=$1',
      [sale.order_id]);
    expect(count.rows[0]?.n).toBe(0);

    await admin.updatePartnerCommercialTerms({ partner_id: f.partnerId,
      commercial_model: 'commission', commission_percent: 7, monthly_fee: null,
      actor_label: 'teste', idempotency_key: `terms-before-${randomUUID()}` }, db.pool);
    await partner.updatePartnerDeliveryStatus(f.ctx, sale.order_id, {
      delivery_status: 'delivered', payment_method: 'pix', delivery_courier: 'Teste',
    });

    const created = await db.pool.query<{
      id: string; commission_percent: string; commission_amount: string; status: string;
    }>('SELECT id,commission_percent,commission_amount,status FROM network.commission_entries WHERE partner_order_id=$1',
      [sale.order_id]);
    expect(Number(created.rows[0]?.commission_percent)).toBe(7);
    expect(Number(created.rows[0]?.commission_amount)).toBe(14);
    expect(created.rows[0]?.status).toBe('open');

    await admin.updatePartnerCommercialTerms({ partner_id: f.partnerId,
      commercial_model: 'commission', commission_percent: 9, monthly_fee: null,
      actor_label: 'teste', idempotency_key: `terms-after-${randomUUID()}` }, db.pool);
    const frozen = await db.pool.query<{ commission_percent: string }>(
      'SELECT commission_percent FROM network.commission_entries WHERE id=$1', [created.rows[0]!.id]);
    expect(Number(frozen.rows[0]?.commission_percent)).toBe(7);

    const settleInput = { partner_id: f.partnerId, settled_by: 'teste',
      idempotency_key: `settle-${randomUUID()}`, reason: 'recebido no teste' };
    const first = await admin.settleCommissionEntries(settleInput, db.pool);
    const replay = await admin.settleCommissionEntries(settleInput, db.pool);
    expect(replay).toMatchObject(first);
    expect(replay.replayed).toBe(true);

    await partner.cancelPartnerSale(f.ctx, sale.order_id, 'cancelamento pós-liquidação');
    const final = await db.pool.query<{ status: string; settled_at: string | null }>(
      'SELECT status,settled_at FROM network.commission_entries WHERE id=$1', [created.rows[0]!.id]);
    expect(final.rows[0]?.status).toBe('reversed');
    expect(final.rows[0]?.settled_at).toBeTruthy();
    const events = await db.pool.query<{ event_type: string }>(
      'SELECT event_type FROM network.commission_entry_events WHERE commission_entry_id=$1 ORDER BY created_at',
      [created.rows[0]!.id]);
    expect(events.rows.map((row) => row.event_type)).toEqual(['created','settled','reversed']);
  });

  it('papel parceiro não lê o filme de comissão', async () => {
    const restricted = new Pool({ connectionString: buildRestrictedConnectionString(db.connectionString) });
    await expect(restricted.query('SELECT * FROM network.commission_entry_events LIMIT 1'))
      .rejects.toThrow(/permission denied/i);
    await restricted.end();
  });
});
