// Regressão encontrada pelo Opus, ampliada com política única, lotes e falhas repetidas.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPartnerFixture } from './helpers/partner-fixtures.js';
import { buildRestrictedConnectionString, startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';
import { waitForDatabaseBlock } from './helpers/database-barrier.js';

let db: IntegrationDb;
beforeAll(async () => {
  db = await startPostgres();
  Object.assign(process.env, {
    NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: db.connectionString,
    CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'test-admin-token',
    PARTNER_DATABASE_URL: buildRestrictedConnectionString(db.connectionString),
    WHOLESALE_UNIFIED_STOCK: 'true', WHOLESALE_MATRIZ_DECREMENT: 'true', WHOLESALE_MATRIZ_OVERSELL_GUARD: 'true',
    WHOLESALE_MATRIZ_RETAIL_COST: 'true', MATRIZ_CENTRAL_LEDGER: 'true', PHOTO_REQUESTS: 'false',
    GOOGLE_MAPS_API_KEY: 'fixture-no-network', BOT_PICKUP_RESERVATION_HOURS: '24',
  });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Rede externa proibida neste teste'); }));
  await db.pool.query(`INSERT INTO core.units(environment,slug,name) VALUES ('test','main','Matriz') ON CONFLICT DO NOTHING`);
}, 240_000);
afterAll(async () => {
  vi.unstubAllGlobals();
  const { partnerPool } = await import('../../src/parceiro/db.js');
  await partnerPool.end().catch(() => undefined);
  if (db) await stopPostgres(db);
});

let serial = 992000;
async function bareOrders(n: number, environment = 'test') {
  const contact = (await db.pool.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name)
    VALUES ($1,$2,'Fixture reserva') RETURNING id`, [environment, ++serial])).rows[0].id;
  const unit = (await db.pool.query(`INSERT INTO core.units(environment,slug,name) VALUES ($1,'main','Matriz')
    ON CONFLICT(environment,slug) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [environment])).rows[0].id;
  return (await db.pool.query(`INSERT INTO commerce.orders
    (environment,contact_id,total_amount,status,fulfillment_mode,source,unit_id,idempotency_key,created_at)
    SELECT $1,$2,0,'open','pickup','chatwoot_com_bot',$3,'bot:order:'||$4||':'||g,
      date_trunc('second',now())-interval '25 hours'+interval '0.123456 seconds'
    FROM generate_series(1,$5::int) g RETURNING id,order_number`,
  [environment, contact, unit, randomUUID(), n])).rows as Array<{ id: string; order_number: string }>;
}

async function partnerReservation() {
  const fx = await createPartnerFixture(db.pool);
  const { materializePartnerOrder } = await import('../../src/atendente-v2/fulfillment.js');
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const actual = await materializePartnerOrder(client, fx.ctx, { customer_name: 'Fixture reserva',
      customer_phone: null, items: [{ partner_stock_id: fx.stockId, quantity: 2, unit_price: 150 }],
      fulfillment_mode: 'pickup', delivery_address: null, freight_amount: 0,
      reserve_for_pickup: true, idempotency_key: randomUUID() });
    const contact = (await client.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name)
      VALUES ('test',$1,'Fixture reserva') RETURNING id`, [++serial])).rows[0].id;
    const mirror = (await client.query(`INSERT INTO commerce.orders
      (environment,contact_id,total_amount,status,fulfillment_mode,source,unit_id,partner_order_id,idempotency_key,created_at)
      VALUES ('test',$4,300,'open','pickup','chatwoot_com_bot',$1,$2,$3,now()-interval '48 hours') RETURNING id`,
    [fx.unitId, actual.partner_order_id, `bot:order:${randomUUID()}`, contact])).rows[0].id;
    await client.query('COMMIT');
    return { fx, mirror, actual: actual.partner_order_id };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function allowed(id: string, cutoff: string | null) {
  return (await db.pool.query(`SELECT commerce.bot_order_cancellation_allowed(o,p,$2::timestamptz) allowed
    FROM commerce.orders o LEFT JOIN commerce.partner_orders p ON p.environment=o.environment AND p.id=o.partner_order_id
    WHERE o.id=$1`, [id, cutoff])).rows[0].allowed;
}

describe('verificacao: fila da expiracao de 24h', () => {
  it('100 espelhos de pedidos de parceiro ja concluidos nao podem impedir a expiracao de uma reserva real', async () => {
    const fx = await createPartnerFixture(db.pool, { slugSuffix: 'fila', initialStockQty: 200 });
    const partner = await import('../../src/parceiro/queries.js');
    const mirrorContact = (await db.pool.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name,phone_e164)
      VALUES ('test',991000,'Clientes da rede','+5521999990001') RETURNING id`)).rows[0].id;
    for (let i = 0; i < 100; i++) {
      const sale = await partner.registerPartnerSale(fx.ctx, {
        customer_name: `Cliente ${i}`, customer_phone: null,
        items: [{ partner_stock_id: fx.stockId, quantity: 1, unit_price: 150 }],
        payment_method: 'Pix', payment_status: 'received', fulfillment_mode: 'pickup',
        delivery_address: null, source_tag: 'porta', idempotency_key: randomUUID(),
      } as never, db.pool);
      // Espelho que o bot cria para pedido roteado ao parceiro: fica 'open' depois da retirada.
      await db.pool.query(`INSERT INTO commerce.orders
          (environment,contact_id,total_amount,status,fulfillment_mode,source,unit_id,partner_order_id,idempotency_key,created_at)
        VALUES ('test',$4,150,'open','pickup','chatwoot_com_bot',$1,$2,$3,now()-interval '48 hours')`,
      [fx.unitId, sale.order_id, `bot:order:${randomUUID()}:${i}`, mirrorContact]);
    }
    // Reserva REAL da Matriz, vencida (25h), mais nova que os espelhos.
    const product = (await db.pool.query(`INSERT INTO commerce.products(environment,product_code,product_name,product_type,brand,tire_condition)
      VALUES ('test','VERIF-FILA','Pneu fila','tire','Pirelli','meia_vida') RETURNING id`)).rows[0].id;
    await db.pool.query(`INSERT INTO commerce.tire_specs(environment,product_id,tire_size) VALUES ('test',$1,'90/90-19')`, [product]);
    await db.pool.query(`INSERT INTO commerce.matriz_product_prices(environment,product_id,price_amount) VALUES ('test',$1,89)`, [product]);
    await db.pool.query(`INSERT INTO commerce.wholesale_stock(environment,measure,brand,tire_condition,quantity_on_hand,unit_cost)
      VALUES ('test','90/90-19','Pirelli','meia_vida',5,40)`);
    const contact = (await db.pool.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name,phone_e164)
      VALUES ('test',991001,'Cliente real','+5521999990000') RETURNING id`)).rows[0].id;
    const conv = (await db.pool.query(`INSERT INTO core.conversations(environment,chatwoot_conversation_id,chatwoot_account_id,
      contact_id,current_status,started_at,last_activity_at) VALUES ('test',991001,9818,$1,'open',now(),now()) RETURNING id`, [contact])).rows[0].id;
    const tools = await import('../../src/atendente-v2/tools.js');
    const client = await db.pool.connect();
    let created: { ok?: boolean; order_number?: string; erro?: string };
    try {
      await client.query('BEGIN');
      created = JSON.parse(await tools.executeTool(client, 'test', conv, 'criar_pedido', { nome_cliente: 'Joao Real',
        modalidade: 'pickup', forma_pagamento: 'pix', itens: [{ product_id: product, quantidade: 2, preco_unitario: 89 }] },
        undefined, { triggerMessageId: randomUUID() }));
      await client.query('COMMIT');
    } finally { client.release(); }
    expect(created.ok).toBe(true);
    await db.pool.query(`UPDATE commerce.orders SET created_at=now()-interval '25 hours' WHERE environment='test' AND order_number=$1`, [created.order_number]);
    const { expireBotReservations } = await import('../../src/operation/bot-reservations.js');
    const expired = await expireBotReservations('test', db.pool, new Date());
    const real = (await db.pool.query(`SELECT status FROM commerce.orders WHERE environment='test' AND order_number=$1`, [created.order_number])).rows[0];
    const stock = (await db.pool.query(`SELECT quantity_reserved FROM commerce.wholesale_stock WHERE environment='test' AND measure='90/90-19'`)).rows[0];
    console.log('FILA DA EXPIRACAO:', JSON.stringify({ expiradas: expired, reserva_real: real, reservado_no_galpao: stock.quantity_reserved }));
    expect(real.status).toBe('cancelled');
    expect(expired).toBe(1);
    expect(stock.quantity_reserved).toBe(0);
    expect(await expireBotReservations('test', db.pool)).toBe(0);
    expect((await db.pool.query(`SELECT count(*)::int n FROM commerce.orders WHERE unit_id=$1 AND status='open'`,
      [fx.unitId])).rows[0].n).toBe(100); // Não sincroniza o espelho nesta correção.
  });

  it.each(['pickup_arrived_at', 'pickup_installation_started_at'] as const)(
    'exclui parceiro com %s no dono e preserva a proteção no cancelamento', async column => {
      const p = await partnerReservation();
      const stage = column === 'pickup_installation_started_at'
        ? 'pickup_arrived_at=now(),pickup_installation_started_at=now()' : 'pickup_arrived_at=now()';
      await db.pool.query(`UPDATE commerce.partner_orders SET ${stage} WHERE id=$1`, [p.actual]);
      const cutoff = new Date(Date.now()-24*3_600_000).toISOString();
      expect(await allowed(p.mirror, cutoff)).toBe(false);
      const { expireBotReservations } = await import('../../src/operation/bot-reservations.js');
      const [real] = await bareOrders(1);
      expect(await expireBotReservations('test', db.pool)).toBe(1);
      await expect(db.pool.query(`SELECT commerce.cancel_open_bot_order('test',$1,'fixture','teste',$2::timestamptz)`,
        [p.mirror, cutoff])).rejects.toThrow('order_status_changed');
      expect((await db.pool.query(`SELECT status FROM commerce.orders WHERE id=$1`, [real.id])).rows[0].status).toBe('cancelled');
      expect((await db.pool.query(`SELECT quantity_reserved FROM commerce.partner_stock_levels WHERE id=$1`,
        [p.fx.stockId])).rows[0].quantity_reserved).toBe(2);
    });

  it('percorre mais de dois lotes, preserva microssegundos e separa ambientes', async () => {
    const rows = await bareOrders(205);
    const [other] = await bareOrders(1, 'prod');
    const { expireBotReservations } = await import('../../src/operation/bot-reservations.js');
    expect(await expireBotReservations('test', db.pool)).toBe(205);
    expect((await db.pool.query(`SELECT count(*)::int n FROM commerce.orders WHERE id=ANY($1::uuid[]) AND status='cancelled'`,
      [rows.map(o => o.id)])).rows[0].n).toBe(205);
    expect((await db.pool.query(`SELECT status FROM commerce.orders WHERE id=$1`, [other.id])).rows[0].status).toBe('open');
    expect(await expireBotReservations('test', db.pool)).toBe(0);
  });

  it('expira reserva válida do parceiro pelo motor dele, liberando uma só vez', async () => {
    const p = await partnerReservation();
    const { expireBotReservations } = await import('../../src/operation/bot-reservations.js');
    expect(await expireBotReservations('test', db.pool)).toBe(1);
    expect(await expireBotReservations('test', db.pool)).toBe(0);
    const stock = (await db.pool.query(`SELECT quantity_on_hand,quantity_reserved FROM commerce.partner_stock_levels WHERE id=$1`,
      [p.fx.stockId])).rows[0];
    expect(stock).toMatchObject({ quantity_on_hand: 10, quantity_reserved: 0 });
    expect((await db.pool.query(`SELECT status FROM commerce.partner_orders WHERE id=$1`, [p.actual])).rows[0].status).toBe('cancelled');
  });

  it('revalida chegada concorrente no parceiro sem gerar falso alarme', async () => {
    const p = await partnerReservation();
    const holder = await db.pool.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM commerce.partner_orders WHERE id=$1 FOR UPDATE', [p.actual]);
    const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    const { expireBotReservations } = await import('../../src/operation/bot-reservations.js');
    const run = expireBotReservations('test', db.pool);
    try {
      await waitForDatabaseBlock(db.pool, pid);
      await holder.query('UPDATE commerce.partner_orders SET pickup_arrived_at=now() WHERE id=$1', [p.actual]);
      await holder.query('COMMIT');
      expect(await run).toBe(0);
    } finally { await holder.query('ROLLBACK'); holder.release(); }
    expect((await db.pool.query('SELECT count(*)::int n FROM ops.bot_reservation_expiry_failures WHERE order_id=$1',
      [p.mirror])).rows[0].n).toBe(0);
    expect((await db.pool.query('SELECT status FROM commerce.orders WHERE id=$1', [p.mirror])).rows[0].status).toBe('open');
  });

  it('avança após 100 falhas, espera entre tentativas e avisa após três; some quando resolve', async () => {
    const bad = await bareOrders(100);
    await db.pool.query(`UPDATE commerce.orders SET created_at=created_at-interval '1 hour' WHERE id=ANY($1::uuid[])`, [bad.map(r => r.id)]);
    await db.pool.query(`CREATE FUNCTION public.fixture_expiry_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id=ANY(TG_ARGV[0]::uuid[]) THEN RAISE EXCEPTION 'order_status_changed'; END IF; RETURN NEW; END $$`);
    await db.pool.query(`CREATE TRIGGER fixture_expiry_fail BEFORE UPDATE ON commerce.orders FOR EACH ROW
      EXECUTE FUNCTION public.fixture_expiry_fail('{${bad.map(r => r.id).join(',')}}')`);
    const [good] = await bareOrders(1);
    const { expireBotReservations, botReservationExpiryFailures } = await import('../../src/operation/bot-reservations.js');
    const now = new Date();
    try {
      expect(await expireBotReservations('test', db.pool, now)).toBe(1);
      expect((await db.pool.query('SELECT status FROM commerce.orders WHERE id=$1', [good.id])).rows[0].status).toBe('cancelled');
      expect((await botReservationExpiryFailures('test', db.pool)).count).toBe(0);
      await expireBotReservations('test', db.pool, now); // Respeita retry_after.
      expect((await db.pool.query('SELECT min(attempts)::int n FROM ops.bot_reservation_expiry_failures')).rows[0].n).toBe(1);
      await expireBotReservations('test', db.pool, new Date(now.getTime()+61_000));
      await expireBotReservations('test', db.pool, new Date(now.getTime()+182_000));
      const { getMatrizNotificacoes } = await import('../../src/admin/painel/queries-notificacoes.js');
      const alerts = (await getMatrizNotificacoes('test', db.pool)).bot_reservation_expiry_failures;
      expect(alerts).toMatchObject({ count: 100, matrix_count: 100 });
      expect(alerts.orders).toHaveLength(10);
      expect(alerts.orders[0]).toHaveProperty('order_number');
      expect((await botReservationExpiryFailures('prod', db.pool)).count).toBe(0);
    } finally {
      await db.pool.query('DROP TRIGGER fixture_expiry_fail ON commerce.orders; DROP FUNCTION public.fixture_expiry_fail()');
    }
    expect(await expireBotReservations('test', db.pool, new Date(now.getTime()+423_000))).toBe(100);
    expect((await botReservationExpiryFailures('test', db.pool)).count).toBe(0);
    expect((await db.pool.query('SELECT count(*)::int n FROM ops.bot_reservation_expiry_failures')).rows[0].n).toBe(0);
  });

  it('preserva cancelamento solicitado pelo cliente antes de 24h e de entrega', async () => {
    const [recent, delivery, manual] = await bareOrders(3);
    await db.pool.query('UPDATE commerce.orders SET created_at=now() WHERE id=$1', [recent.id]);
    await db.pool.query("UPDATE commerce.orders SET fulfillment_mode='delivery',delivery_address='Rua teste, 1' WHERE id=$1", [delivery.id]);
    await db.pool.query("UPDATE commerce.orders SET idempotency_key='manual-fixture' WHERE id=$1", [manual.id]);
    const cutoff = new Date(Date.now()-24*3_600_000).toISOString();
    for (const row of [recent, delivery, manual]) {
      expect(await allowed(row.id, cutoff)).toBe(false);
      expect(await allowed(row.id, null)).toBe(true);
      await db.pool.query(`SELECT commerce.cancel_open_bot_order('test',$1,'cliente','desistiu')`, [row.id]);
    }
  });

  it('duas réplicas não duplicam cancelamentos nem misturam estado de falha', async () => {
    const rows = await bareOrders(12);
    const { expireBotReservations } = await import('../../src/operation/bot-reservations.js');
    const results = await Promise.all([expireBotReservations('test', db.pool), expireBotReservations('test', db.pool)]);
    expect(results.reduce((sum,n) => sum+n,0)).toBe(12);
    expect((await db.pool.query(`SELECT count(*)::int n FROM audit.events
      WHERE event_type='manual_order_cancelled' AND entity_id=ANY($1::uuid[])`, [rows.map(o => o.id)])).rows[0].n).toBe(12);
    const [other] = await bareOrders(1, 'prod');
    await expect(db.pool.query(`INSERT INTO ops.bot_reservation_expiry_failures
      (environment,order_id,attempts,last_failed_at,retry_after,error_code)
      VALUES ('test',$1,1,now(),now(),'fixture')`, [other.id])).rejects.toThrow();
    const security = (await db.pool.query(`SELECT relrowsecurity,
      has_table_privilege('farejador_partner_app',oid,'SELECT') readable
      FROM pg_class WHERE oid='ops.bot_reservation_expiry_failures'::regclass`)).rows[0];
    expect(security).toEqual({ relrowsecurity: true, readable: false });
  });
});
