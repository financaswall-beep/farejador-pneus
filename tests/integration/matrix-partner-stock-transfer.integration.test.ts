import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPartnerFixture } from './helpers/partner-fixtures.js';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('transferência de estoque Matriz → parceiro', () => {
  let db: IntegrationDb;
  let registerSale: typeof import(
    '../../src/admin/painel/queries-atacado-vendas.js'
  ).registerWholesaleSale;
  let settleArrival: typeof import(
    '../../src/admin/painel/queries-partner-transfer-arrival.js'
  ).settlePartnerArrival;
  let returnCargo: typeof import(
    '../../src/admin/painel/queries-partner-cargo.js'
  ).returnPartnerCargoToMatrix;
  let settleSale: typeof import(
    '../../src/admin/painel/queries-financeiro-integridade.js'
  ).settleWholesaleOrderPayment;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
      CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'emergency-token',
      WHOLESALE_STOCK_DECREMENT: 'true', WHOLESALE_FINANCE: 'true',
      MATRIZ_CENTRAL_LEDGER: 'true',
    });
    vi.resetModules();
    db = await startPostgres();
    ({ registerWholesaleSale: registerSale }
      = await import('../../src/admin/painel/queries-atacado-vendas.js'));
    ({ settlePartnerArrival: settleArrival }
      = await import('../../src/admin/painel/queries-partner-transfer-arrival.js'));
    ({ returnPartnerCargoToMatrix: returnCargo }
      = await import('../../src/admin/painel/queries-partner-cargo.js'));
    ({ settleWholesaleOrderPayment: settleSale }
      = await import('../../src/admin/painel/queries-financeiro-integridade.js'));
  }, 180_000);

  afterAll(async () => {
    if (db) await stopPostgres(db);
    process.env.MATRIZ_CENTRAL_LEDGER = 'false';
  });

  it('cria recebimento, acerta recusa, retorna carga e sincroniza pagamento', async () => {
    const partner = await createPartnerFixture(db.pool, { slugSuffix: 'transfer-0183' });
    const measure = '92/92-19';
    const brand = 'Marca Transferência';
    const product = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.products(
         environment,product_code,product_name,product_type,brand,tire_condition
       ) VALUES ('test',$1,'Pneu transferência','tire',$2,'novo') RETURNING id`,
      [`TRANSFER-${randomUUID()}`, brand],
    );
    await db.pool.query(
      `INSERT INTO commerce.tire_specs(
         environment,product_id,tire_size,width_mm,aspect_ratio,rim_diameter
       ) VALUES ('test',$1,$2,92,92,19)`,
      [product.rows[0]!.id, measure],
    );
    await db.pool.query(
      `INSERT INTO commerce.wholesale_stock(
         environment,measure,brand,tire_condition,quantity_on_hand,quantity_reserved,unit_cost
       ) VALUES ('test',$1,$2,'novo',20,0,100)`,
      [measure, brand],
    );
    const dueDate = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const original = await registerSale({
      environment: 'test', partner_id: partner.partnerId,
      partner_unit_id: partner.partnerUnitId,
      items: [{ measure,brand,tire_condition:'novo',quantity:2,unit_price:150 }],
      payment_status:'pending',due_date:dueDate,created_by:'owner:test',
      idempotency_key:randomUUID(),
    }, db.pool);

    expect(original).toMatchObject({
      partner_unit_id:partner.partnerUnitId,parent_order_id:null,
      status:'pending',payment_status:'pending',partner_payment_terms:'credit',
    });
    expect(original.linked_partner_purchase_id).toBeTruthy();
    const mirrored = await db.pool.query(
      `SELECT stock.quantity_on_hand,p.receipt_status,p.total_amount::text,
              p.payment_status AS purchase_payment_status,
              item.quantity,item.unit_cost::text,payable.status,
              sale.status AS sale_status,sale.payment_status AS sale_payment_status
         FROM commerce.wholesale_stock stock
         JOIN commerce.partner_purchases p ON p.id=$3
         JOIN commerce.partner_purchase_items item ON item.purchase_id=p.id
         JOIN finance.partner_payables payable ON payable.source_purchase_id=p.id
         JOIN commerce.wholesale_orders sale ON sale.id=p.source_wholesale_order_id
        WHERE stock.environment='test' AND stock.measure=$1 AND stock.brand=$2`,
      [measure,brand,original.linked_partner_purchase_id],
    );
    expect(mirrored.rows[0]).toMatchObject({
      quantity_on_hand:18,receipt_status:'pending',total_amount:'300.00',
      purchase_payment_status:'payable',quantity:2,unit_cost:'150.00',status:'open',
      sale_status:'pending',sale_payment_status:'pending',
    });
    const beforeArrivalLedger = await db.pool.query(
      `SELECT source_type,amount::text FROM finance.matriz_ledger_transactions
        WHERE environment='test' AND source_id=$1 ORDER BY source_type`,
      [original.order_id],
    );
    expect(beforeArrivalLedger.rows).toEqual([{
      source_type:'commerce.wholesale_order.partner_dispatch',amount:'200.00',
    }]);
    const originalItem = await db.pool.query<{ id: string }>(
      `SELECT id FROM commerce.wholesale_order_items WHERE order_id=$1`, [original.order_id],
    );
    await settleArrival({
      environment:'test',order_id:original.order_id,actor_label:'owner:test',
      idempotency_key:randomUUID(),
      items:[{ order_item_id:originalItem.rows[0]!.id,accepted_quantity:2 }],
    }, db.pool);
    const afterArrival = await db.pool.query(
      `SELECT status,payment_status,partner_transfer_status,settled_total_amount::text
         FROM commerce.wholesale_orders WHERE environment='test' AND id=$1`,
      [original.order_id],
    );
    expect(afterArrival.rows[0]).toEqual({
      status:'confirmed',payment_status:'pending',partner_transfer_status:'settled',
      settled_total_amount:'300.00',
    });
    const afterArrivalLedger = await db.pool.query(
      `SELECT source_type,amount::text FROM finance.matriz_ledger_transactions
        WHERE environment='test' AND source_id=$1 ORDER BY source_type`,
      [original.order_id],
    );
    expect(afterArrivalLedger.rows).toEqual([
      { source_type:'commerce.wholesale_order.arrival_cogs',amount:'200.00' },
      { source_type:'commerce.wholesale_order.arrival_revenue',amount:'300.00' },
      { source_type:'commerce.wholesale_order.partner_dispatch',amount:'200.00' },
    ]);

    const addition = await registerSale({
      environment:'test',parent_order_id:original.order_id,
      partner_unit_id:partner.partnerUnitId,
      items:[{ measure,brand,tire_condition:'novo',quantity:1,unit_price:160 }],
      payment_status:'pending',due_date:dueDate,created_by:'owner:test',
      idempotency_key:randomUUID(),
    }, db.pool);
    expect(addition.parent_order_id).toBe(original.order_id);
    expect(addition.linked_partner_purchase_id).toBeTruthy();
    await expect(db.pool.query(
      `SELECT quantity_on_hand FROM commerce.wholesale_stock
        WHERE environment='test' AND measure=$1 AND brand=$2`,
      [measure,brand],
    )).resolves.toMatchObject({ rows:[{ quantity_on_hand:17 }] });

    const additionItem = await db.pool.query<{ id: string }>(
      `SELECT id FROM commerce.wholesale_order_items WHERE order_id=$1`, [addition.order_id],
    );
    const arrival = await settleArrival({
      environment:'test',order_id:addition.order_id,actor_label:'owner:test',
      idempotency_key:randomUUID(),
      items:[{ order_item_id:additionItem.rows[0]!.id,accepted_quantity:0 }],
    }, db.pool);
    const cargoId = String((arrival.rejected_cargo as Array<{ cargo_lot_id:string }>)[0]!.cargo_lot_id);
    await returnCargo({ environment:'test',cargo_lot_id:cargoId,
      reason:'retorno físico',actor_label:'owner:test',idempotency_key:randomUUID() }, db.pool);
    const cancelled = await db.pool.query(
      `SELECT stock.quantity_on_hand,p.total_amount::text AS purchase_total,
              payable.status AS payable_status
         FROM commerce.wholesale_stock stock
         JOIN commerce.partner_purchases p ON p.id=$3
         JOIN finance.partner_payables payable ON payable.source_purchase_id=p.id
        WHERE stock.environment='test' AND stock.measure=$1 AND stock.brand=$2`,
      [measure,brand,addition.linked_partner_purchase_id],
    );
    expect(cancelled.rows[0]).toMatchObject({
      quantity_on_hand:18,purchase_total:'0.00',payable_status:'cancelled',
    });

    await settleSale(original.order_id,'test',db.pool,{
      idempotency_key:randomUUID(),actor_label:'owner:test',payment_method:'pix',
    });
    const paid = await db.pool.query(
      `SELECT sale.payment_status,purchase.payment_status AS purchase_payment_status,
              payable.status AS payable_status
         FROM commerce.wholesale_orders sale
         JOIN commerce.partner_purchases purchase
           ON purchase.source_wholesale_order_id=sale.id
         JOIN finance.partner_payables payable ON payable.source_purchase_id=purchase.id
        WHERE sale.environment='test' AND sale.id=$1`,
      [original.order_id],
    );
    expect(paid.rows[0]).toEqual({
      payment_status:'paid',purchase_payment_status:'paid_now',payable_status:'paid',
    });
  }, 60_000);

  it('só reconhece a venda à vista pelos pneus aceitos na chegada', async () => {
    const partner = await createPartnerFixture(db.pool, { slugSuffix: 'cash-arrival-0187' });
    const measure = '83/83-17';
    const brand = 'Marca Acerto à Vista';
    const product = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.products(
         environment,product_code,product_name,product_type,brand,tire_condition
       ) VALUES ('test',$1,'Pneu acerto à vista','tire',$2,'meia_vida') RETURNING id`,
      [`CASH-ARRIVAL-${randomUUID()}`, brand],
    );
    await db.pool.query(
      `INSERT INTO commerce.tire_specs(
         environment,product_id,tire_size,width_mm,aspect_ratio,rim_diameter
       ) VALUES ('test',$1,$2,83,83,17)`,
      [product.rows[0]!.id, measure],
    );
    await db.pool.query(
      `INSERT INTO commerce.wholesale_stock(
         environment,measure,brand,tire_condition,quantity_on_hand,quantity_reserved,unit_cost
       ) VALUES ('test',$1,$2,'meia_vida',10,0,80)`,
      [measure, brand],
    );

    const sale = await registerSale({
      environment:'test',partner_id:partner.partnerId,
      partner_unit_id:partner.partnerUnitId,
      items:[{ measure,brand,tire_condition:'meia_vida',quantity:3,unit_price:100 }],
      payment_status:'paid',created_by:'owner:test',idempotency_key:randomUUID(),
    }, db.pool);
    expect(sale).toMatchObject({
      status:'pending',payment_status:'pending',partner_payment_terms:'cash_on_arrival',
    });
    const pending = await db.pool.query(
      `SELECT sale.status,sale.payment_status,sale.paid_at,
              purchase.payment_status AS purchase_payment_status,
              payable.status AS payable_status
         FROM commerce.wholesale_orders sale
         JOIN commerce.partner_purchases purchase
           ON purchase.source_wholesale_order_id=sale.id
         JOIN finance.partner_payables payable ON payable.source_purchase_id=purchase.id
        WHERE sale.environment='test' AND sale.id=$1`,
      [sale.order_id],
    );
    expect(pending.rows[0]).toEqual({
      status:'pending',payment_status:'pending',paid_at:null,
      purchase_payment_status:'payable',payable_status:'open',
    });

    const item = await db.pool.query<{ id: string }>(
      `SELECT id FROM commerce.wholesale_order_items WHERE order_id=$1`, [sale.order_id],
    );
    const arrival = await settleArrival({
      environment:'test',order_id:sale.order_id,actor_label:'owner:test',
      idempotency_key:randomUUID(),
      items:[{ order_item_id:item.rows[0]!.id,accepted_quantity:2 }],
    }, db.pool);
    expect(arrival).toMatchObject({
      payment_status:'paid',total_amount:'200.00',accepted_units:2,
    });

    const final = await db.pool.query(
      `SELECT sale.status,sale.payment_status,(sale.paid_at IS NOT NULL) AS paid,
              sale.settled_total_amount::text,
              purchase.payment_status AS purchase_payment_status,
              purchase.total_amount::text AS purchase_total,
              payable.status AS payable_status,payable.amount::text AS payable_amount
         FROM commerce.wholesale_orders sale
         JOIN commerce.partner_purchases purchase
           ON purchase.source_wholesale_order_id=sale.id
         JOIN finance.partner_payables payable ON payable.source_purchase_id=purchase.id
        WHERE sale.environment='test' AND sale.id=$1`,
      [sale.order_id],
    );
    expect(final.rows[0]).toEqual({
      status:'confirmed',payment_status:'paid',paid:true,settled_total_amount:'200.00',
      purchase_payment_status:'paid_now',purchase_total:'200.00',
      payable_status:'paid',payable_amount:'200.00',
    });
    const ledger = await db.pool.query(
      `SELECT source_type,amount::text,(cash_on IS NOT NULL) AS cash
         FROM finance.matriz_ledger_transactions
        WHERE environment='test' AND source_id=$1 ORDER BY source_type`,
      [sale.order_id],
    );
    expect(ledger.rows).toEqual([
      { source_type:'commerce.wholesale_order.arrival_cogs',amount:'160.00',cash:false },
      { source_type:'commerce.wholesale_order.arrival_revenue',amount:'200.00',cash:true },
      { source_type:'commerce.wholesale_order.partner_dispatch',amount:'240.00',cash:false },
    ]);
  }, 60_000);
});
