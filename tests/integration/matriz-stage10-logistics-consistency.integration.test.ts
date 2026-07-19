import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('Etapa 10 - consistencia operacional e financeira da rota', () => {
  let db: IntegrationDb;
  let unitId: string;
  let contactSequence = 93_000;
  let openTrip: typeof import('../../src/admin/painel/queries-logistica-rotas.js').openMatrizTrip;
  let closeTrip: typeof import('../../src/admin/painel/queries-logistica-rotas.js').closeMatrizTrip;
  let attachOrder: typeof import('../../src/admin/painel/queries-logistica-rotas.js').attachOrderToMatrizTrip;
  let setDelivery: typeof import('../../src/admin/painel/queries-logistica.js').setMatrizDeliveryStatus;
  let approveReceipt: typeof import('../../src/admin/painel/queries-logistica-comprovantes-decision.js').approveMatrizTripReceipt;
  let confirmDivergence: typeof import('../../src/admin/painel/queries-logistica-rotas.js').confirmMatrizTripFuelDivergence;
  let getLogistics: typeof import('../../src/admin/painel/queries-logistica-read.js').getMatrizLogistica;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
      CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'emergency-token',
    });
    db = await startPostgres();
    ({ openMatrizTrip: openTrip, closeMatrizTrip: closeTrip,
      attachOrderToMatrizTrip: attachOrder,
      confirmMatrizTripFuelDivergence: confirmDivergence } =
      await import('../../src/admin/painel/queries-logistica-rotas.js'));
    ({ setMatrizDeliveryStatus: setDelivery } =
      await import('../../src/admin/painel/queries-logistica.js'));
    ({ getMatrizLogistica: getLogistics } =
      await import('../../src/admin/painel/queries-logistica-read.js'));
    ({ approveMatrizTripReceipt: approveReceipt } =
      await import('../../src/admin/painel/queries-logistica-comprovantes-decision.js'));
    const unit = await db.pool.query<{ id: string }>(
      `INSERT INTO core.units (environment,slug,name)
       VALUES ('test','main','Matriz Etapa 10') RETURNING id`,
    );
    unitId = unit.rows[0]!.id;
  }, 120_000);

  afterAll(async () => { if (db) await stopPostgres(db); });

  async function seedDelivery(label: string): Promise<string> {
    contactSequence += 1;
    const contact = await db.pool.query<{ id: string }>(
      `INSERT INTO core.contacts (environment,chatwoot_contact_id,name)
       VALUES ('test',$1,$2) RETURNING id`,
      [contactSequence, `Cliente ${label}`],
    );
    const order = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.orders
         (environment,contact_id,unit_id,total_amount,status,fulfillment_mode,delivery_address)
       VALUES ('test',$1,$2,100,'open','delivery',$3) RETURNING id`,
      [contact.rows[0]!.id, unitId, `Rua ${label}, 10`],
    );
    return order.rows[0]!.id;
  }

  async function createTrip(label: string, orderId: string): Promise<string> {
    const trip = await openTrip({
      courier_name: `Entregador ${label}`, order_ids: [orderId],
      created_by: 'owner-stage10', environment: 'test',
    }, db.pool);
    return trip.trip_id;
  }

  it('bloqueia o fechamento quando existe entrega pending ou dispatched', async () => {
    const dispatchedOrder = await seedDelivery('dispatched');
    const dispatchedTrip = await createTrip('dispatched', dispatchedOrder);
    await expect(closeTrip({ trip_id: dispatchedTrip, environment: 'test' }, db.pool))
      .rejects.toThrow('trip_has_unresolved_deliveries');

    const pendingOrder = await seedDelivery('pending');
    const pendingTrip = await createTrip('pending', pendingOrder);
    await db.pool.query(
      `UPDATE commerce.orders SET delivery_status='pending' WHERE id=$1`, [pendingOrder],
    );
    await expect(closeTrip({ trip_id: pendingTrip, environment: 'test' }, db.pool))
      .rejects.toThrow('trip_has_unresolved_deliveries');
  });

  it('fecha com failed reportado, despendura sem cancelar e preserva trilha imutavel', async () => {
    const orderId = await seedDelivery('failed');
    const tripId = await createTrip('failed', orderId);
    await db.pool.query(
      `UPDATE commerce.orders
          SET delivery_status='failed',delivery_failure_reason='Cliente ausente'
        WHERE id=$1`, [orderId],
    );

    await closeTrip({
      trip_id: tripId, environment: 'test', actor_label: 'owner-stage10',
    } as Parameters<typeof closeTrip>[0], db.pool);

    const order = await db.pool.query(
      `SELECT status,delivery_status,delivery_failure_reason,trip_id
         FROM commerce.orders WHERE id=$1`, [orderId],
    );
    expect(order.rows[0]).toEqual({
      status: 'open', delivery_status: 'failed',
      delivery_failure_reason: 'Cliente ausente', trip_id: null,
    });
    const event = await db.pool.query(
      `SELECT event_type,payload_before,payload_after
         FROM audit.events
        WHERE environment='test' AND entity_table='commerce.orders' AND entity_id=$1
          AND event_type='delivery_report_detached_on_trip_close'`,
      [orderId],
    );
    expect(event.rows).toHaveLength(1);
    expect(event.rows[0].payload_before).toMatchObject({
      trip_id: tripId, delivery_status: 'failed',
      delivery_failure_reason: 'Cliente ausente',
    });
    expect(event.rows[0].payload_after).toMatchObject({
      trip_id: null, owner_decision_required: true,
    });
  });

  it('aceita apenas estados terminais delivered/cancelled no vinculo restante', async () => {
    const deliveredOrder = await seedDelivery('delivered');
    const deliveredTrip = await createTrip('delivered', deliveredOrder);
    await db.pool.query(
      `UPDATE commerce.orders
          SET delivery_status='delivered',delivered_at=now()
        WHERE id=$1`, [deliveredOrder],
    );
    await expect(closeTrip({ trip_id: deliveredTrip, environment: 'test' }, db.pool))
      .resolves.toMatchObject({ trip_id: deliveredTrip });

    const cancelledOrder = await seedDelivery('cancelled');
    const cancelledTrip = await createTrip('cancelled', cancelledOrder);
    await db.pool.query(
      `UPDATE commerce.orders SET status='cancelled' WHERE id=$1`, [cancelledOrder],
    );
    await expect(closeTrip({ trip_id: cancelledTrip, environment: 'test' }, db.pool))
      .resolves.toMatchObject({ trip_id: cancelledTrip });
  });

  it('serializa entregar e pendurar pelo cadeado da rota e revalida depois da espera', async () => {
    const deliveryOrder = await seedDelivery('race-delivery');
    const deliveryTrip = await createTrip('race-delivery', deliveryOrder);
    const locker = await db.pool.connect();
    await locker.query('BEGIN');
    await locker.query(
      `SELECT id FROM commerce.matriz_delivery_trips WHERE id=$1 FOR UPDATE`,
      [deliveryTrip],
    );
    const deliveryOutcome = setDelivery({
      order_id: deliveryOrder, status: 'delivered', environment: 'test',
    }, db.pool).then(() => 'resolved', (error: unknown) => error);
    const deliveryEarly = await Promise.race([
      deliveryOutcome,
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 150)),
    ]);
    await locker.query(
      `UPDATE commerce.matriz_delivery_trips
          SET status='closed',ended_at=now() WHERE id=$1`, [deliveryTrip],
    );
    await locker.query('COMMIT');
    locker.release();
    expect(deliveryEarly).toBe('blocked');
    const deliveryFinal = await deliveryOutcome;
    expect(deliveryFinal).toBeInstanceOf(Error);
    expect((deliveryFinal as Error).message).toBe('delivery_not_found');

    const routeOrder = await seedDelivery('race-attach-route');
    const attachTrip = await createTrip('race-attach-route', routeOrder);
    const looseOrder = await seedDelivery('race-attach-loose');
    const attachLocker = await db.pool.connect();
    await attachLocker.query('BEGIN');
    await attachLocker.query(
      `SELECT id FROM commerce.matriz_delivery_trips WHERE id=$1 FOR UPDATE`,
      [attachTrip],
    );
    const attachOutcome = attachOrder({
      order_id: looseOrder, trip_id: attachTrip, environment: 'test',
    }, db.pool).then(() => 'resolved', (error: unknown) => error);
    const attachEarly = await Promise.race([
      attachOutcome,
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 150)),
    ]);
    await attachLocker.query(
      `UPDATE commerce.matriz_delivery_trips
          SET status='closed',ended_at=now() WHERE id=$1`, [attachTrip],
    );
    await attachLocker.query('COMMIT');
    attachLocker.release();
    expect(attachEarly).toBe('blocked');
    const attachFinal = await attachOutcome;
    expect(attachFinal).toBeInstanceOf(Error);
    expect((attachFinal as Error).message).toBe('trip_not_open');
  });

  it('repete o fechamento sem reescrever o diario original', async () => {
    const orderId = await seedDelivery('close-replay');
    const tripId = await createTrip('close-replay', orderId);
    await db.pool.query(
      `UPDATE commerce.orders SET delivery_status='delivered',delivered_at=now() WHERE id=$1`,
      [orderId],
    );
    const first = await closeTrip({
      trip_id: tripId, km_end: 120, fuel_spent: 35, notes: 'primeiro fechamento',
      environment: 'test',
    }, db.pool);
    expect(await closeTrip({
      trip_id: tripId, km_end: 999, fuel_spent: 99, notes: 'retry divergente',
      environment: 'test',
    }, db.pool)).toEqual(first);
    const row = await db.pool.query(
      `SELECT km_end::text,fuel_spent::text,notes
         FROM commerce.matriz_delivery_trips WHERE id=$1`, [tripId],
    );
    expect(row.rows[0]).toEqual({
      km_end: '120.0', fuel_spent: '35.00', notes: 'primeiro fechamento',
    });
  });

  it('deriva pendente/reconciliado sem escrever fuel_expense_id', async () => {
    const reconciledOrder = await seedDelivery('reconciled');
    const reconciledTrip = await createTrip('reconciled', reconciledOrder);
    await db.pool.query(
      `UPDATE commerce.orders SET delivery_status='delivered',delivered_at=now() WHERE id=$1`,
      [reconciledOrder],
    );
    await closeTrip({ trip_id: reconciledTrip, environment: 'test' }, db.pool);

    const pendingOrder = await seedDelivery('fuel-pending');
    const pendingTrip = await createTrip('fuel-pending', pendingOrder);
    await db.pool.query(
      `UPDATE commerce.orders SET delivery_status='delivered',delivered_at=now() WHERE id=$1`,
      [pendingOrder],
    );
    await closeTrip({ trip_id: pendingTrip, fuel_spent: 50, environment: 'test' }, db.pool);

    const logistics = await getLogistics('test', db.pool);
    const reconciled = logistics.rotas_recentes.find((trip) => trip.id === reconciledTrip) as any;
    const pending = logistics.rotas_recentes.find((trip) => trip.id === pendingTrip) as any;
    expect(reconciled.financial_status).toBe('reconciled');
    expect(pending.financial_status).toBe('pending');
    const legacyLinks = await db.pool.query(
      `SELECT id,fuel_expense_id FROM commerce.matriz_delivery_trips WHERE id=ANY($1::uuid[])`,
      [[reconciledTrip, pendingTrip]],
    );
    expect(legacyLinks.rows.every((row) => row.fuel_expense_id === null)).toBe(true);
  });

  it('mantem comprovante em revisao pendente e exige owner para confirmar divergencia zero-tolerancia', async () => {
    const pendingTrip = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.matriz_delivery_trips(environment,courier_name)
       VALUES ('test','Receipt pending') RETURNING id`,
    );
    await db.pool.query(
      `INSERT INTO commerce.matriz_trip_receipts
        (environment,trip_id,mime,size_bytes,ai_status,workflow_status)
       VALUES ('test',$1,'image/jpeg',11,'skipped','review_required')`,
      [pendingTrip.rows[0]!.id],
    );
    await closeTrip({ trip_id: pendingTrip.rows[0]!.id, environment: 'test' }, db.pool);

    const divergentTrip = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.matriz_delivery_trips(environment,courier_name)
       VALUES ('test','Receipt divergent') RETURNING id`,
    );
    const receipt = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.matriz_trip_receipts
        (environment,trip_id,mime,size_bytes,ai_status,workflow_status)
       VALUES ('test',$1,'image/jpeg',15,'skipped','review_required') RETURNING id`,
      [divergentTrip.rows[0]!.id],
    );
    await db.pool.query(
      `INSERT INTO commerce.matriz_trip_receipt_blobs(receipt_id,environment,bytes)
       VALUES ($1,'test',convert_to('receipt-stage10','UTF8'))`,
      [receipt.rows[0]!.id],
    );
    await approveReceipt({
      receipt_id: receipt.rows[0]!.id, amount: 60, category: 'combustivel',
      merchant: 'Posto Teste', document_date: '2026-07-18',
      competence_month: '2026-07-01', payment_status: 'paid',
      payment_date: '2026-07-18', idempotency_key: 'stage10-divergent-receipt',
      actor_label: 'owner-stage10', environment: 'test',
    }, db.pool);
    await closeTrip({
      trip_id: divergentTrip.rows[0]!.id, fuel_spent: 50, environment: 'test',
    }, db.pool);

    let logistics = await getLogistics('test', db.pool);
    expect((logistics.rotas_recentes.find((trip) => trip.id === pendingTrip.rows[0]!.id) as any)
      .financial_status).toBe('pending');
    expect((logistics.rotas_recentes.find((trip) => trip.id === divergentTrip.rows[0]!.id) as any)
      .financial_status).toBe('divergent');

    await confirmDivergence({
      trip_id: divergentTrip.rows[0]!.id, actor_label: 'owner-stage10',
      environment: 'test',
    }, db.pool);
    logistics = await getLogistics('test', db.pool);
    expect((logistics.rotas_recentes.find((trip) => trip.id === divergentTrip.rows[0]!.id) as any)
      .financial_status).toBe('reconciled');
    const audit = await db.pool.query(
      `SELECT payload_before,payload_after FROM audit.events
        WHERE entity_id=$1 AND event_type='fuel_divergence_confirmed'`,
      [divergentTrip.rows[0]!.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].payload_before).toMatchObject({
      fuel_spent: 50, approved_fuel_amount: 60,
    });
  });

  it('mantem o parceiro sem leitura das tabelas e da funcao financeira da Matriz', async () => {
    const privileges = await db.pool.query<{ relation: string; can_read: boolean }>(
      `SELECT relation,has_table_privilege('farejador_partner_app',relation,'SELECT') can_read
         FROM unnest(ARRAY[
           'commerce.matriz_delivery_trips',
           'commerce.matriz_trip_receipts',
           'commerce.matriz_trip_receipt_blobs',
           'finance.matriz_payroll_adjustments',
           'finance.matriz_payroll_items'
         ]) relation`,
    );
    expect(privileges.rows.every((row) => row.can_read === false)).toBe(true);
    const fn = await db.pool.query<{ can_execute: boolean }>(
      `SELECT has_function_privilege('farejador_partner_app',p.oid,'EXECUTE') can_execute
         FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='commerce' AND p.proname='matriz_trip_financial_status'`,
    );
    expect(fn.rows).toHaveLength(1);
    expect(fn.rows[0]!.can_execute).toBe(false);
  });
});
