import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startPostgres, stopPostgres, applyMigrationFile, type IntegrationDb } from './helpers/postgres.js';

describe('faturamento do Bot pela realização da venda', () => {
  let db: IntegrationDb;
  let today: string;
  let unitId: string;
  let sequence = 0;
  let movement: typeof import('../../src/admin/painel/queries-bot-movimento.js');
  beforeAll(async () => {
    Object.assign(process.env, { NODE_ENV: 'test', FAREJADOR_ENV: 'test',
      DATABASE_URL: 'postgres://test', CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'test-token' });
    vi.resetModules();
    db = await startPostgres();
    movement = await import('../../src/admin/painel/queries-bot-movimento.js');
    today = (await db.pool.query(`SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date::text today`)).rows[0].today;
    unitId = (await db.pool.query(`INSERT INTO core.units(environment,slug,name)
      VALUES('test','partner-metrics','Parceiro métricas') RETURNING id`)).rows[0].id;
  }, 180_000);
  afterAll(async () => { if (db) await stopPostgres(db); });

  async function order(status = 'open', mode = 'pickup', options: {
    simulator?: boolean; source?: string; environment?: string; old?: boolean;
  } = {}) {
    const env = options.environment ?? 'test';
    const contact = (await db.pool.query(`INSERT INTO core.contacts
      (environment,chatwoot_contact_id,name) VALUES($1,$2,'Métricas teste') RETURNING id`,
    [env, 988000 + ++sequence])).rows[0].id;
    const conversation = (await db.pool.query(`INSERT INTO core.conversations
      (environment,chatwoot_conversation_id,chatwoot_account_id,contact_id,current_status,started_at,additional_attributes)
      VALUES($1,$2,1,$3,'open',now()-interval '2 days',$4::jsonb) RETURNING id`,
    [env, 988000 + sequence, contact, JSON.stringify({ farejador_simulator: options.simulator ?? false })])).rows[0].id;
    return (await db.pool.query(`INSERT INTO commerce.orders
      (environment,contact_id,source_conversation_id,status,fulfillment_mode,total_amount,source,
        delivery_address,created_at)
      VALUES($1,$2,$3,$4,$5,100,$6,CASE WHEN $5='delivery' THEN 'Rua Teste, 10' END,
        CASE WHEN $7 THEN now()-interval '2 days' ELSE now() END) RETURNING id`,
    [env, contact, conversation, status, mode, options.source ?? 'chatwoot_com_bot', options.old ?? false])).rows[0].id as string;
  }

  async function expectRevenue(amount: number, sales: number) {
    const payload = await movement.getBotMovement({ mode: 'daily', selectedDate: today, today }, 'test', db.pool);
    expect(payload.cards.faturamento).toBe(amount);
    expect(payload.cards.fecharam).toBe(sales);
    const row = (await db.pool.query(`SELECT faturamento,fecharam FROM analytics.v_daily_metrics
      WHERE environment='test' AND dia=$1::date`, [today])).rows[0];
    expect(Number(row?.faturamento ?? 0)).toBe(amount);
    expect(Number(row?.fecharam ?? 0)).toBe(sales);
  }

  it('não oscila com reservas/editáveis e usa a data realizada sem contar simulador, manual ou outro ambiente', async () => {
    const open = await order();
    await order('confirmed', 'delivery');
    await order('paid', 'pickup', { simulator: true });
    await order('confirmed', 'pickup', { source: 'chatwoot_sem_bot' });
    await order('paid', 'pickup', { environment: 'prod' });
    await expectRevenue(0, 0);
    await db.pool.query(`UPDATE commerce.orders SET total_amount=269 WHERE id=$1`, [open]);
    await expectRevenue(0, 0);
    await db.pool.query(`UPDATE commerce.orders SET status='cancelled' WHERE id=$1`, [open]);
    await expectRevenue(0, 0);

    const pickup = await order('paid', 'pickup', { old: true });
    await db.pool.query(`UPDATE commerce.orders SET retrieved_at=now() WHERE id=$1`, [pickup]);
    await expectRevenue(100, 1);
    const delivery = await order('confirmed', 'delivery', { old: true });
    await db.pool.query(`UPDATE commerce.orders SET delivery_status='delivered',delivered_at=now() WHERE id=$1`, [delivery]);
    await expectRevenue(200, 2);
    await db.pool.query(`UPDATE commerce.orders SET status='cancelled' WHERE id=$1`, [pickup]);
    await expectRevenue(100, 1);
    await applyMigrationFile(db.pool, '0238_bot_realized_sales_metrics.sql');
    await expectRevenue(100, 1);
  });

  it('parceiro aguardando retirada ou cancelado não entra; retirada usa valor e data do parceiro', async () => {
    const parent = await order('confirmed');
    const partner = (await db.pool.query(`INSERT INTO commerce.partner_orders
      (environment,unit_id,total_amount,status,fulfillment_mode,awaiting_pickup,created_at)
      VALUES('test',$1,150,'confirmed','pickup',true,now()-interval '2 days') RETURNING id`, [unitId])).rows[0].id;
    await db.pool.query(`UPDATE commerce.orders SET partner_order_id=$2 WHERE id=$1`, [parent, partner]);
    await expectRevenue(100, 1);
    await db.pool.query(`UPDATE commerce.partner_orders SET awaiting_pickup=false,retrieved_at=now() WHERE id=$1`, [partner]);
    await expectRevenue(250, 2);
    await db.pool.query(`UPDATE commerce.partner_orders SET status='cancelled' WHERE id=$1`, [partner]);
    await expectRevenue(100, 1);
  });
});
