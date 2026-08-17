import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('integridade intermodular da aba Vendas da Matriz', () => {
  let db: IntegrationDb;
  let testUnitId: string;
  let prodUnitId: string;
  let customerId: string;
  let productId: string;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
      CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'emergency-token',
    });
    db = await startPostgres();
    const units = await db.pool.query<{ id: string; environment: string }>(
      `INSERT INTO core.units(environment,slug,name,is_active) VALUES
         ('test','main','Matriz teste',true),('prod','main','Matriz prod',true)
       ON CONFLICT (environment,slug) DO UPDATE SET is_active=true
       RETURNING id,environment::text`,
    );
    testUnitId = units.rows.find((row) => row.environment === 'test')!.id;
    prodUnitId = units.rows.find((row) => row.environment === 'prod')!.id;
    customerId = (await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.customers(environment,name,phone_e164)
       VALUES ('test','Cliente balcão integração','+5521999990000') RETURNING id`,
    )).rows[0]!.id;
    productId = (await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.products(environment,product_code,product_name,product_type)
       VALUES ('test','SALES-INTEGRITY','Pneu integridade','tire') RETURNING id`,
    )).rows[0]!.id;
  }, 180_000);

  afterAll(async () => { if (db) await stopPostgres(db); });

  it('o banco barra mistura de ambiente, contato alheio, desconto impossível e datas invertidas', async () => {
    await expect(db.pool.query(
      `INSERT INTO commerce.orders
         (environment,customer_id,total_amount,status,fulfillment_mode,payment_method,
          idempotency_key,source,unit_id)
       VALUES ('test',$1,10,'confirmed','pickup','pix','cross-env-sales','walkin_balcao',$2)`,
      [customerId, prodUnitId],
    )).rejects.toThrow();

    const contacts = await db.pool.query<{ id: string }>(
      `INSERT INTO core.contacts(environment,chatwoot_contact_id,name) VALUES
         ('test',910001,'Contato correto'),('test',910002,'Contato errado') RETURNING id`,
    );
    const conversation = await db.pool.query<{ id: string }>(
      `INSERT INTO core.conversations
         (environment,chatwoot_conversation_id,chatwoot_account_id,contact_id,current_status,started_at)
       VALUES ('test',920001,1,$1,'open',now()) RETURNING id`, [contacts.rows[0]!.id],
    );
    await expect(db.pool.query(
      `INSERT INTO commerce.orders
         (environment,contact_id,source_conversation_id,total_amount,status,fulfillment_mode,
          payment_method,idempotency_key,source,unit_id)
       VALUES ('test',$1,$2,10,'confirmed','pickup','pix','wrong-contact-sales',
               'chatwoot_sem_bot',$3)`,
      [contacts.rows[1]!.id, conversation.rows[0]!.id, testUnitId],
    )).rejects.toThrow('conversation_contact_mismatch');

    const orderId = (await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.orders
         (environment,customer_id,total_amount,status,fulfillment_mode,payment_method,
          idempotency_key,source,unit_id)
       VALUES ('test',$1,10,'confirmed','pickup','pix','discount-check-sales',
               'walkin_balcao',$2) RETURNING id`, [customerId, testUnitId],
    )).rows[0]!.id;
    await expect(db.pool.query(
      `INSERT INTO commerce.order_items
         (environment,order_id,product_id,quantity,unit_price,discount_amount)
       VALUES ('test',$1,$2,1,10,10.01)`, [orderId, productId],
    )).rejects.toThrow();

    const buyerId = (await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.wholesale_customers(environment,name)
       VALUES ('test','Comprador datas') RETURNING id`,
    )).rows[0]!.id;
    await expect(db.pool.query(
      `INSERT INTO commerce.wholesale_orders
         (environment,buyer_id,total_amount,status,payment_status,sold_at,paid_at,created_by)
       VALUES ('test',$1,10,'confirmed','paid',now(),now()-interval '1 minute','teste')`,
      [buyerId],
    )).rejects.toThrow();

    await expect(db.pool.query(
      `INSERT INTO commerce.wholesale_orders
         (environment,buyer_id,total_amount,status,payment_status,sold_at,created_by)
       VALUES ('test',$1,10,'confirmed','paid',now()+interval '2 days','teste')`,
      [buyerId],
    )).rejects.toThrow('sold_at_future');

    await expect(db.pool.query(
      `INSERT INTO commerce.wholesale_orders
         (environment,buyer_id,total_amount,status,payment_status,sold_at,paid_at,created_by)
       VALUES ('test',$1,10,'confirmed','paid',now(),now()+interval '2 days','teste')`,
      [buyerId],
    )).rejects.toThrow('paid_at_future');
  });

  it('resumos contam só venda confirmada, logística reconhece balcão e históricos não truncam', async () => {
    const orders = await db.pool.query<{ id: string; status: string }>(
      `INSERT INTO commerce.orders
         (environment,customer_id,total_amount,status,fulfillment_mode,payment_method,
          idempotency_key,source,unit_id,delivery_address)
       VALUES
         ('test',$1,100,'open','pickup','pix','summary-open-sales','walkin_balcao',$2,NULL),
         ('test',$1,200,'confirmed','pickup','pix','summary-confirmed-sales','walkin_balcao',$2,NULL),
         ('test',$1,300,'confirmed','delivery','pix','logistics-walkin-sales','walkin_balcao',$2,'Rua Teste, 10')
       RETURNING id,status`, [customerId, testUnitId],
    );
    for (const row of orders.rows.slice(0, 2)) {
      await db.pool.query(
        `INSERT INTO commerce.order_items
           (environment,order_id,product_id,quantity,unit_price,discount_amount,matriz_unit_cost)
         VALUES ('test',$1,$2,1,$3,0,50)`,
        [row.id, productId, row.status === 'open' ? 100 : 200],
      );
    }

    const { getVarejoResumo, getWholesaleResumo } =
      await import('../../src/admin/painel/queries-galpao.js');
    const resumo = await getVarejoResumo('today', 'test', db.pool);
    expect(resumo).toMatchObject({ faturamento: '200.00', vendas_count: 1, pending_count: 1 });

    const { getMatrizLogistica } = await import('../../src/admin/painel/queries-logistica-read.js');
    const logistics = await getMatrizLogistica('test', db.pool);
    expect(logistics.abertas.find((row) => row.order_id === orders.rows[2]!.id))
      .toMatchObject({ customer_name: 'Cliente balcão integração', customer_phone: '+5521999990000' });

    await db.pool.query(
      `INSERT INTO commerce.orders
         (environment,customer_id,total_amount,status,fulfillment_mode,payment_method,
          idempotency_key,source,unit_id,created_at)
       SELECT 'test',$1,1,'confirmed','pickup','pix','history-retail-'||g,
              'walkin_balcao',$2,now()
         FROM generate_series(1,55) g`, [customerId, testUnitId],
    );
    const { getPainelPedidosSalesHistory } =
      await import('../../src/admin/painel/queries-pedidos.js');
    expect((await getPainelPedidosSalesHistory('30d', 'test', db.pool)).length)
      .toBeGreaterThanOrEqual(58);

    const buyerId = (await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.wholesale_customers(environment,name)
       VALUES ('test','Comprador histórico') RETURNING id`,
    )).rows[0]!.id;
    await db.pool.query(
      `INSERT INTO commerce.wholesale_orders
         (environment,buyer_id,total_amount,status,payment_status,sold_at,created_by)
       SELECT 'test',$1,1,'confirmed','paid',now(),'historico'
         FROM generate_series(1,20)`, [buyerId],
    );
    const recentWholesaleId = (await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.wholesale_orders
         (environment,buyer_id,total_amount,status,payment_status,sold_at,created_at,created_by)
       VALUES ('test',$1,123,'confirmed','paid',now(),now()-interval '60 days','competencia')
       RETURNING id`, [buyerId],
    )).rows[0]!.id;
    const oldWholesaleId = (await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.wholesale_orders
         (environment,buyer_id,total_amount,status,payment_status,sold_at,created_at,created_by)
       VALUES ('test',$1,456,'confirmed','paid',now()-interval '60 days',now(),'competencia')
       RETURNING id`, [buyerId],
    )).rows[0]!.id;
    await db.pool.query(
      `INSERT INTO commerce.wholesale_order_items
         (environment,order_id,measure,brand,tire_condition,quantity,unit_price,unit_cost)
       VALUES ('test',$1,'90/90-18','Pirelli','meia_vida',1,123,50),
              ('test',$2,'100/90-18','Pirelli','meia_vida',1,456,50)`,
      [recentWholesaleId, oldWholesaleId],
    );
    const { listWholesaleSalesHistory } =
      await import('../../src/admin/painel/queries-atacado-cancelar.js');
    expect((await listWholesaleSalesHistory('30d', 'test', db.pool)).length)
      .toBeGreaterThanOrEqual(21);
    expect(await getWholesaleResumo('test', db.pool, '30d')).toMatchObject({ faturamento: '123.00' });
  });

  it('trava só a medida vendida e mantém o restante do galpão disponível', async () => {
    const suffix = Date.now();
    const requestedMeasure = `210/50-${suffix % 40 + 10}`;
    const unrelatedMeasure = `220/55-${suffix % 40 + 10}`;
    const requestedProductId = (await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.products
         (environment,product_code,product_name,product_type,brand,tire_condition)
       VALUES ('test',$1,'Pneu lock direcionado','tire','Sem marca','meia_vida')
       RETURNING id`, [`LOCK-${suffix}`],
    )).rows[0]!.id;
    await db.pool.query(
      `INSERT INTO commerce.tire_specs(environment,product_id,tire_size)
       VALUES ('test',$1,$2)`, [requestedProductId, requestedMeasure],
    );
    await db.pool.query(
      `INSERT INTO commerce.wholesale_stock
         (environment,measure,brand,tire_condition,quantity_on_hand,unit_cost)
       VALUES ('test',$1,'Sem marca','meia_vida',5,40),
              ('test',$2,'Sem marca','meia_vida',5,40)`,
      [requestedMeasure, unrelatedMeasure],
    );

    const locker = await db.pool.connect();
    const observer = await db.pool.connect();
    try {
      await locker.query('BEGIN');
      const { prepareMatrizWalkinStock } =
        await import('../../src/admin/painel/matriz-walkin-stock.js');
      await prepareMatrizWalkinStock(locker, 'test', [
        { productId: requestedProductId, quantity: 1 },
      ]);

      await observer.query("SET lock_timeout='300ms'");
      await expect(observer.query(
        `UPDATE commerce.wholesale_stock SET notes=COALESCE(notes,'')
          WHERE environment='test' AND measure=$1`, [unrelatedMeasure],
      )).resolves.toMatchObject({ rowCount: 1 });
      await expect(observer.query(
        `UPDATE commerce.wholesale_stock SET notes=COALESCE(notes,'')
          WHERE environment='test' AND measure=$1`, [requestedMeasure],
      )).rejects.toThrow(/lock timeout/i);
    } finally {
      await locker.query('ROLLBACK');
      await observer.query('RESET lock_timeout');
      locker.release();
      observer.release();
    }
  });
});
