import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';
import { createPartnerFixture } from './helpers/partner-fixtures.js';

let db: IntegrationDb;

beforeAll(async () => {
  db = await startPostgres();
  process.env.DATABASE_URL = db.connectionString;
  process.env.PARTNER_DATABASE_URL = db.connectionString;
  process.env.FAREJADOR_ENV = 'test';
  process.env.NODE_ENV = 'test';
  process.env.CHATWOOT_HMAC_SECRET = 'pickup-workflow-test';
  process.env.ADMIN_AUTH_TOKEN = 'pickup-workflow-admin-token-123';
}, 180_000);

afterAll(async () => {
  if (db) await stopPostgres(db);
});

async function transaction(work: (client: PoolClient) => Promise<void>) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN'); await work(client); await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK'); throw error;
  } finally { client.release(); }
}

describe('retirada com serviços na mesma verdade comercial', () => {
  it('parceiro só mexe em estoque, venda e caixa na confirmação final', async () => {
    const queries = await import('../../src/parceiro/queries.js');
    const fixture = await createPartnerFixture(db.pool, { initialStockQty: 5 });
    const created = await db.pool.query<{ order_id: string }>(
      `SELECT commerce.register_partner_local_order(
         'test',$1,'Cliente Serviço',NULL,$2::jsonb,'A receber','pickup',NULL,
         'integration:pickup-service',$3,'2w',0,0,true
       ) order_id`,
      [fixture.unitId, JSON.stringify([{
        partner_stock_id: fixture.stockId, quantity: 1, unit_price: 80,
      }]), `pickup-service-${randomUUID()}`],
    );
    const orderId = created.rows[0]!.order_id;
    const services = [
      { code: 'mounting' as const, charge_mode: 'charged' as const, amount_cents: 2000 },
      { code: 'valve_change' as const, charge_mode: 'courtesy' as const, amount_cents: 0 },
    ];
    await queries.updatePartnerPickupStage(fixture.ctx, orderId, {
      stage: 'installing', services,
    });
    const pending = await db.pool.query(
      `SELECT order_row.total_amount,stock.quantity_on_hand,stock.quantity_reserved,
              (SELECT count(*)::int FROM commerce.partner_order_items item
                WHERE item.order_id=order_row.id AND item.pickup_service_code IS NOT NULL) services,
              (SELECT count(*)::int FROM finance.partner_receivables receivable
                WHERE receivable.source_order_id=order_row.id) receipts
         FROM commerce.partner_orders order_row
         JOIN commerce.partner_stock_levels stock ON stock.id=$2
        WHERE order_row.id=$1`,
      [orderId, fixture.stockId],
    );
    expect(pending.rows[0]).toMatchObject({
      total_amount: '80.00', quantity_on_hand: 5, quantity_reserved: 1,
      services: 0, receipts: 0,
    });

    await queries.markPartnerPickupRetrieved(fixture.ctx, orderId, {
      payment_method: 'Pix',
    });
    const completed = await db.pool.query(
      `SELECT order_row.total_amount,order_row.status,order_row.awaiting_pickup,
              stock.quantity_on_hand,stock.quantity_reserved,
              (SELECT count(*)::int FROM commerce.partner_order_items item
                WHERE item.order_id=order_row.id AND item.pickup_service_code IS NOT NULL) services,
              (SELECT COALESCE(sum(item.unit_price),0)::text FROM commerce.partner_order_items item
                WHERE item.order_id=order_row.id AND item.pickup_service_code IS NOT NULL) service_total,
              (SELECT count(*)::int FROM commerce.partner_order_items item
                WHERE item.order_id=order_row.id AND item.cost_status='known'
                  AND item.pickup_service_code IS NOT NULL) known_cost_services,
              (SELECT amount::text FROM finance.partner_receivables receivable
                WHERE receivable.source_order_id=order_row.id) receipt_amount
         FROM commerce.partner_orders order_row
         JOIN commerce.partner_stock_levels stock ON stock.id=$2
        WHERE order_row.id=$1`,
      [orderId, fixture.stockId],
    );
    expect(completed.rows[0]).toMatchObject({
      total_amount: '100.00', status: 'paid', awaiting_pickup: false,
      quantity_on_hand: 4, quantity_reserved: 0, services: 2,
      service_total: '20.00', known_cost_services: 2, receipt_amount: '100.00',
    });
    const tireRanking = await queries.getPartnerRelatorioPneus(fixture.ctx);
    expect(tireRanking).toHaveLength(1);
    expect((tireRanking[0] as { qtd: number }).qtd).toBe(1);
  });

  it('Matriz materializa serviço sem consumir estoque extra', async () => {
    const actions = await import('../../src/admin/painel/queries-pedidos-acoes.js');
    const pickups = await import('../../src/admin/painel/queries-pickups.js');
    const unit = await db.pool.query<{ id: string }>(
      `INSERT INTO core.units(environment,slug,name,is_active)
       VALUES ('test','main','Matriz',true)
       ON CONFLICT (environment,slug) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
    );
    const contact = await db.pool.query<{ id: string }>(
      `INSERT INTO core.contacts(environment,chatwoot_contact_id,name)
       VALUES ('test',$1,'Cliente Matriz') RETURNING id`,
      [Math.floor(Math.random() * 1_000_000_000)],
    );
    const product = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.products(environment,product_code,product_name,product_type,brand,tire_condition)
       VALUES ('test',$1,'Pneu retirada Matriz','tire','Teste','meia_vida') RETURNING id`,
      [`PICKUP-TIRE-${randomUUID()}`],
    );
    await db.pool.query(
      `INSERT INTO commerce.tire_specs(environment,product_id,tire_size) VALUES ('test',$1,'90/90-18')`,
      [product.rows[0]!.id],
    );
    await db.pool.query(
      `INSERT INTO commerce.wholesale_stock(environment,measure,brand,tire_condition,quantity_on_hand,unit_cost)
       VALUES ('test','90/90-18','Teste','meia_vida',3,40)
       ON CONFLICT (environment,measure,brand,tire_condition)
       DO UPDATE SET quantity_on_hand=3,quantity_reserved=0,unit_cost=40`,
    );
    const order = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.orders(environment,contact_id,total_amount,status,fulfillment_mode,
         payment_method,unit_id,source,idempotency_key)
       VALUES ('test',$1,80,'open','pickup','A receber',$2,'chatwoot_com_bot',$3) RETURNING id`,
      [contact.rows[0]!.id, unit.rows[0]!.id, `matrix-pickup-${randomUUID()}`],
    );
    await db.pool.query(
      `INSERT INTO commerce.order_items(environment,order_id,product_id,quantity,unit_price,
         discount_amount,reference_unit_price,matriz_unit_cost)
       VALUES ('test',$1,$2,1,80,0,80,40)`,
      [order.rows[0]!.id, product.rows[0]!.id],
    );
    const reservation = await import('../../src/atendente-v2/matriz-stock-reservation.js');
    await transaction((client) => reservation.reserveMatrizGalpaoStock(
      client, 'test', order.rows[0]!.id, [{ productId: product.rows[0]!.id, quantity: 1 }], true,
    ));
    const services = [{ code: 'mounting' as const,
      charge_mode: 'charged' as const, amount_cents: 1500 }];
    await pickups.updateMatrizPickupStage({
      order_id: order.rows[0]!.id, stage: 'arrived', services,
      actor_label: 'integration', environment: 'test',
    }, db.pool);
    await actions.completeMatrizPickup({
      order_id: order.rows[0]!.id, actor_label: 'integration',
      environment: 'test', payment_method: 'Dinheiro', services,
    }, db.pool);
    const state = await db.pool.query(
      `SELECT order_row.total_amount,order_row.status,stock.quantity_on_hand,
              stock.quantity_reserved,count(item.id) FILTER (
                WHERE item.pickup_service_code IS NOT NULL)::int services
         FROM commerce.orders order_row
         JOIN commerce.order_items item ON item.order_id=order_row.id
         JOIN commerce.wholesale_stock stock
           ON stock.environment='test' AND stock.measure='90/90-18'
          AND stock.brand='Teste' AND stock.tire_condition='meia_vida'
        WHERE order_row.id=$1
        GROUP BY order_row.id,stock.quantity_on_hand,stock.quantity_reserved`,
      [order.rows[0]!.id],
    );
    expect(state.rows[0]).toMatchObject({
      total_amount: '95.00', status: 'paid', quantity_on_hand: 2,
      quantity_reserved: 0, services: 1,
    });
  });

  it('rota operacional de Retiradas não cancela uma venda comum da Matriz', async () => {
    const cancellation = await import('../../src/admin/painel/queries-pickup-cancel.js');
    const unit = await db.pool.query<{ id: string }>(
      `INSERT INTO core.units(environment,slug,name,is_active)
       VALUES ('test','main','Matriz',true)
       ON CONFLICT (environment,slug) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
    );
    const contact = await db.pool.query<{ id: string }>(
      `INSERT INTO core.contacts(environment,chatwoot_contact_id,name)
       VALUES ('test',$1,'Venda comum') RETURNING id`,
      [Math.floor(Math.random() * 1_000_000_000)],
    );
    const order = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.orders(environment,contact_id,total_amount,status,fulfillment_mode,
         payment_method,unit_id,source,idempotency_key)
       VALUES ('test',$1,50,'open','delivery','Pix',$2,'manual',$3) RETURNING id`,
      [contact.rows[0]!.id, unit.rows[0]!.id, `ordinary-sale-${randomUUID()}`],
    );

    await expect(cancellation.cancelMatrizPickup({
      order_id: order.rows[0]!.id,
      actor_label: 'integration',
      reason: 'não deve cancelar',
      environment: 'test',
    }, db.pool)).rejects.toThrow('pickup_not_found');

    const preserved = await db.pool.query<{ status: string }>(
      `SELECT status FROM commerce.orders WHERE environment='test' AND id=$1`,
      [order.rows[0]!.id],
    );
    expect(preserved.rows[0]?.status).toBe('open');
  });
});
