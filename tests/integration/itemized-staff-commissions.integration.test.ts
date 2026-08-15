import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPartnerFixture } from './helpers/partner-fixtures.js';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

const rules = {
  tire: { kind: 'fixed', value: 10 },
  service: { kind: 'percent', value: 5 },
  other: { kind: 'none', value: 0 },
} as const;

describe('0173 — comissão por tipo de item', () => {
  let db: IntegrationDb;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
      CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'emergency-token',
    });
    db = await startPostgres();
    process.env.DATABASE_URL = db.connectionString;
  }, 180_000);

  afterAll(async () => { if (db) await stopPostgres(db); });

  it('soma pneu fixo por unidade e serviço percentual no parceiro', async () => {
    const partner = await import('../../src/parceiro/queries.js');
    const fixture = await createPartnerFixture(db.pool, {
      role: 'funcionario', initialStockQty: 8,
    });
    const service = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.partner_stock_levels
        (environment,unit_id,item_name,item_type,quantity_on_hand,minimum_quantity,
         average_cost,sale_price,is_tracked,stock_status,updated_by)
       VALUES ('test',$1,'Macarrão','servico',NULL,NULL,NULL,25,false,'not_tracked','fixture')
       RETURNING id`,
      [fixture.unitId],
    );
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    await db.pool.query(
      `INSERT INTO network.partner_token_commission_history
        (environment,partner_unit_id,token_id,kind,value,active,starts_on,updated_by,itemized,item_rules)
       VALUES ('test',$1,$2,'fixed',10,true,$3,'integration-test',true,$4::jsonb)`,
      [fixture.partnerUnitId, fixture.tokenId, today, JSON.stringify(rules)],
    );
    await db.pool.query(
      `INSERT INTO network.partner_token_commission
        (token_id,environment,partner_unit_id,kind,value,active,updated_by,itemized,item_rules)
       VALUES ($1,'test',$2,'fixed',10,true,'integration-test',true,$3::jsonb)`,
      [fixture.tokenId, fixture.partnerUnitId, JSON.stringify(rules)],
    );

    const sale = await partner.registerPartnerSale(fixture.ctx, {
      customer_name: 'Cliente venda mista',
      items: [
        { partner_stock_id: fixture.stockId, quantity: 2, unit_price: 200 },
        { partner_stock_id: service.rows[0]!.id, quantity: 1, unit_price: 25 },
      ],
      payment_method: 'pix', fulfillment_mode: 'pickup', source_tag: 'porta',
      idempotency_key: `itemized-${randomUUID()}`,
    });

    const entry = await db.pool.query<{
      gross_amount: string; commission_amount: string;
      commission_itemized: boolean; commission_rules: typeof rules;
    }>(
      `SELECT gross_amount::text,commission_amount::text,
              commission_itemized,commission_rules
         FROM finance.partner_staff_commission_entries
        WHERE environment='test' AND partner_order_id=$1`,
      [sale.order_id],
    );
    expect(entry.rows[0]).toEqual({
      gross_amount: '425.00',
      commission_amount: '21.25',
      commission_itemized: true,
      commission_rules: rules,
    });

    await expect(db.pool.query(
      `UPDATE finance.partner_staff_commission_entries
          SET commission_rules=jsonb_set(commission_rules,'{tire,value}','99'::jsonb)
        WHERE environment='test' AND partner_order_id=$1`,
      [sale.order_id],
    )).rejects.toThrow('partner_staff_commission_fact_immutable');
  });

  it('calcula venda mista da Matriz sem aplicar fixo ao serviço barato', async () => {
    const unit = await db.pool.query<{ id: string }>(
      `INSERT INTO core.units (environment,slug,name)
       VALUES ('test',$1,'Matriz comissão itemizada') RETURNING id`,
      [`main-itemized-${randomUUID().slice(0, 8)}`],
    );
    const contact = await db.pool.query<{ id: string }>(
      `INSERT INTO core.contacts (environment,chatwoot_contact_id,name)
       VALUES ('test',$1,'Cliente itemizado') RETURNING id`,
      [Math.floor(20_000_000 + Math.random() * 10_000_000)],
    );
    const products = await db.pool.query<{ id: string; product_type: string }>(
      `INSERT INTO commerce.products
        (environment,product_code,product_name,product_type)
       VALUES ('test',$1,'Pneu itemizado','tire'),
              ('test',$2,'Macarrão','service')
       RETURNING id,product_type`,
      [`tire-${randomUUID()}`, `service-${randomUUID()}`],
    );
    const tireId = products.rows.find((row) => row.product_type === 'tire')!.id;
    const serviceId = products.rows.find((row) => row.product_type === 'service')!.id;
    const order = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.orders
        (environment,contact_id,unit_id,total_amount,status,fulfillment_mode)
       VALUES ('test',$1,$2,425,'confirmed','pickup') RETURNING id`,
      [contact.rows[0]!.id, unit.rows[0]!.id],
    );
    await db.pool.query(
      `INSERT INTO commerce.order_items
        (environment,order_id,product_id,quantity,unit_price,discount_amount)
       VALUES ('test',$1,$2,2,200,0),('test',$1,$3,1,25,0)`,
      [order.rows[0]!.id, tireId, serviceId],
    );

    const amount = await db.pool.query<{ value: string }>(
      `SELECT finance.matriz_retail_itemized_commission(
        'test',$1,$2::jsonb
      )::text AS value`,
      [order.rows[0]!.id, JSON.stringify(rules)],
    );
    expect(amount.rows[0]!.value).toBe('21.25');
  });
});
