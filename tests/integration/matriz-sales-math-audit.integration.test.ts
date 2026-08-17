import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('auditoria matemática formal de Vendas da Matriz', () => {
  let db: IntegrationDb;
  let unitId: string;
  let contactId: string;
  let conversationId: string;
  let productId: string;
  let sellerId: string;
  let commissionSql: string;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
      CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'emergency-token',
      MATRIZ_CENTRAL_LEDGER: 'true', MATRIZ_CENTRAL_LEDGER_READ: 'true',
    });
    vi.resetModules();
    db = await startPostgres();
    process.env.DATABASE_URL = db.connectionString;
    ({ matrizCommissionFactsSql: commissionSql } =
      await import('../../src/admin/caixa/operation-commission-facts.js'));

    unitId = (await db.pool.query<{ id: string }>(
      `INSERT INTO core.units(environment,slug,name,is_active)
       VALUES ('test','main','Matriz matemática',true)
       ON CONFLICT (environment,slug) DO UPDATE SET is_active=true
       RETURNING id`,
    )).rows[0]!.id;
    contactId = (await db.pool.query<{ id: string }>(
      `INSERT INTO core.contacts(environment,chatwoot_contact_id,name)
       VALUES ('test',981001,'Cliente matemática') RETURNING id`,
    )).rows[0]!.id;
    conversationId = (await db.pool.query<{ id: string }>(
      `INSERT INTO core.conversations
         (environment,chatwoot_conversation_id,chatwoot_account_id,contact_id,
          current_status,started_at)
       VALUES ('test',982001,1,$1,'open',now()) RETURNING id`, [contactId],
    )).rows[0]!.id;
    productId = (await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.products
         (environment,product_code,product_name,product_type)
       VALUES ('test','SALE-MATH-0181','Pneu matemática','tire') RETURNING id`,
    )).rows[0]!.id;
    const personId = (await db.pool.query<{ id: string }>(
      `INSERT INTO network.partner_people(environment,username)
       VALUES ('test','vendedor.matematica') RETURNING id`,
    )).rows[0]!.id;
    sellerId = (await db.pool.query<{ id: string }>(
      `INSERT INTO network.matriz_collaborators
         (environment,person_id,display_name,job,job_title,work_area)
       VALUES ('test',$1,'Vendedor Matemática','vendedor','Vendedor','sales')
       RETURNING id`, [personId],
    )).rows[0]!.id;
  }, 180_000);

  afterAll(async () => { if (db) await stopPostgres(db); });

  it('não trata pedido aberto como venda, comissão, cliente comprador ou receita', async () => {
    const openContact = (await db.pool.query<{ id: string }>(
      `INSERT INTO core.contacts(environment,chatwoot_contact_id,name)
       VALUES ('test',981002,'Cliente ainda aberto') RETURNING id`,
    )).rows[0]!.id;
    const openOrder = (await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.orders
         (environment,contact_id,unit_id,total_amount,status,fulfillment_mode,
          seller_collaborator_id,idempotency_key,source)
       VALUES ('test',$1,$2,77.77,'open','pickup',$3,$4,'walkin_balcao')
       RETURNING id`, [openContact, unitId, sellerId, `open-${randomUUID()}`],
    )).rows[0]!.id;
    await db.pool.query(
      `INSERT INTO commerce.order_items
         (environment,order_id,product_id,quantity,unit_price,discount_amount)
       VALUES ('test',$1,$2,1,77.77,0)`, [openOrder, productId],
    );

    const profile = await db.pool.query<{ total_orders: string; total_spent: string | null }>(
      `SELECT total_orders::text,total_spent::text FROM commerce.customer_profile
        WHERE environment='test' AND contact_id=$1`, [openContact],
    );
    expect(profile.rows[0]).toEqual({ total_orders: '0', total_spent: null });

    const bounds = await db.pool.query<{ start_on: string; end_on: string }>(
      `SELECT date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')::date::text start_on,
              (date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')
                +interval '1 month')::date::text end_on`,
    );
    const facts = await db.pool.query(
      `${commissionSql} SELECT source_id FROM ruled WHERE source_id=$4`,
      ['test', bounds.rows[0]!.start_on, bounds.rows[0]!.end_on, openOrder],
    );
    expect(facts.rows).toHaveLength(0);

    const { getMatrizCentralLedgerFinancialTruth } =
      await import('../../src/admin/painel/matriz-ledger-financial-read.js');
    const truth = await getMatrizCentralLedgerFinancialTruth('test', db.pool);
    expect(truth.conciliacao.origens.find((row) => row.origem === 'varejo'))
      .toMatchObject({ origem_total: '0.00', contabilizado: '0.00' });

    await db.pool.query(`DELETE FROM commerce.orders WHERE id=$1`, [openOrder]);
  });

  it('função SQL recusa meio centavo e grava cabeçalho igual à soma exata dos itens', async () => {
    const call = `SELECT commerce.register_manual_order(
      'test',$1,$2,NULL::uuid,$3,$4::jsonb,'pix','pickup',NULL,'auditoria',$5,
      'chatwoot_sem_bot') AS order_id`;
    await expect(db.pool.query(call, [
      contactId, conversationId, unitId,
      JSON.stringify([{ product_id: productId, quantity: 1, unit_price: 2.135 }]),
      `half-cent-${randomUUID()}`,
    ])).rejects.toThrow('unit_price_cent_precision');

    const created = await db.pool.query<{ order_id: string }>(call, [
      contactId, conversationId, unitId,
      JSON.stringify([
        { product_id: productId, quantity: 3, unit_price: 19.99, discount_amount: 0.02 },
        { product_id: productId, quantity: 2, unit_price: 0.10, discount_amount: 0 },
      ]),
      `exact-cents-${randomUUID()}`,
    ]);
    const proof = await db.pool.query<{ header: string; items: string }>(
      `SELECT o.total_amount::text header,
              sum(i.quantity*i.unit_price-i.discount_amount)::text items
         FROM commerce.orders o
         JOIN commerce.order_items i ON i.order_id=o.id AND i.environment=o.environment
        WHERE o.id=$1 GROUP BY o.id`, [created.rows[0]!.order_id],
    );
    expect(proof.rows[0]).toEqual({ header: '60.15', items: '60.15' });
  });

  it('atacado pertence à competência de sold_at, não à data de digitação', async () => {
    const buyerId = (await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.wholesale_customers(environment,name)
       VALUES ('test','Borracharia competência') RETURNING id`,
    )).rows[0]!.id;
    const saleId = (await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.wholesale_orders
         (environment,buyer_id,sold_at,created_at,total_amount,status,payment_status,
          seller_collaborator_id,created_by)
       VALUES ('test',$1,
         (date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')-interval '10 days')
           AT TIME ZONE 'America/Sao_Paulo',
         now(),60.17,'confirmed','paid',$2,'auditoria') RETURNING id`,
      [buyerId, sellerId],
    )).rows[0]!.id;
    await db.pool.query(
      `INSERT INTO commerce.wholesale_order_items
         (environment,order_id,measure,brand,tire_condition,quantity,unit_price,unit_cost)
       VALUES ('test',$1,'90/90-18','Pirelli','meia_vida',3,19.99,10),
              ('test',$1,'100/90-18','Pirelli','meia_vida',2,0.10,0.05)`, [saleId],
    );
    const bounds = await db.pool.query<{
      previous_start: string; current_start: string; next_start: string;
    }>(
      `SELECT (date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')-interval '1 month')::date::text previous_start,
              date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')::date::text current_start,
              (date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')+interval '1 month')::date::text next_start`,
    );
    const b = bounds.rows[0]!;
    await db.pool.query(
      `INSERT INTO network.matriz_collaborator_commission_rules
         (environment,collaborator_id,kind,basis,value,active,starts_on,updated_by)
       VALUES ('test',$1,'percent','revenue',2.5,true,$2::date,'auditoria')`,
      [sellerId, b.previous_start],
    );
    const previousFacts = await db.pool.query(
      `${commissionSql} SELECT source_id,sale_channel,commission_amount::text
        FROM ruled WHERE source_id=$4`,
      ['test', b.previous_start, b.current_start, saleId],
    );
    const currentFacts = await db.pool.query(
      `${commissionSql} SELECT source_id,sale_channel FROM ruled WHERE source_id=$4`,
      ['test', b.current_start, b.next_start, saleId],
    );
    expect(previousFacts.rows).toEqual([{
      source_id: saleId, sale_channel: 'wholesale', commission_amount: '1.50',
    }]);
    expect(currentFacts.rows).toHaveLength(0);

    const { getLegacyMatrizFinancialTruth } =
      await import('../../src/admin/painel/queries-financeiro-verdade.js');
    const truth = await getLegacyMatrizFinancialTruth('test', db.pool);
    expect(truth.conciliacao.origens.find((row) => row.origem === 'atacado')?.origem_total)
      .toBe('0.00');
  });

  it('reconciliação acusa divergência de cabeçalho e volta a zero após rollback', async () => {
    const clean = await db.pool.query<{ metric: string; affected_rows: string }>(
      `SELECT * FROM commerce.matriz_sales_math_reconciliation('test')`,
    );
    expect(clean.rows.every((row) => Number(row.affected_rows) === 0)).toBe(true);

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const buyer = await client.query<{ id: string }>(
        `INSERT INTO commerce.wholesale_customers(environment,name)
         VALUES ('test','Borracharia divergente') RETURNING id`,
      );
      const order = await client.query<{ id: string }>(
        `INSERT INTO commerce.wholesale_orders
           (environment,buyer_id,total_amount,status,created_by)
         VALUES ('test',$1,99,'confirmed','auditoria') RETURNING id`, [buyer.rows[0]!.id],
      );
      await client.query(
        `INSERT INTO commerce.wholesale_order_items
           (environment,order_id,measure,brand,tire_condition,quantity,unit_price,unit_cost)
         VALUES ('test',$1,'80/100-18','Teste','meia_vida',1,10,5)`, [order.rows[0]!.id],
      );
      const dirty = await client.query<{ metric: string; affected_rows: string }>(
        `SELECT * FROM commerce.matriz_sales_math_reconciliation('test')
          WHERE metric='wholesale_header_total_mismatch'`,
      );
      expect(Number(dirty.rows[0]!.affected_rows)).toBe(1);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    const after = await db.pool.query<{ affected_rows: string }>(
      `SELECT affected_rows FROM commerce.matriz_sales_math_reconciliation('test')`,
    );
    expect(after.rows.every((row) => Number(row.affected_rows) === 0)).toBe(true);
  });
});
