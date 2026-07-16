import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('Etapa 4 — verdade financeira da Matriz', () => {
  let db: IntegrationDb;
  let getTruth: typeof import('../../src/admin/painel/queries-financeiro-verdade.js').getMatrizFinancialTruth;
  let mainUnitId: string;
  let productId: string;
  let contactId: string;
  let buyerId: string;
  let supplierId: string;
  let partnerId: string;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
      CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'emergency-token',
    });
    db = await startPostgres();
    ({ getMatrizFinancialTruth: getTruth } = await import('../../src/admin/painel/queries-financeiro-verdade.js'));

    const unit = await db.pool.query<{ id: string }>(
      `INSERT INTO core.units (environment,slug,name,is_active)
       VALUES ('test','main','Matriz Etapa 4',true)
       ON CONFLICT (environment,slug) DO UPDATE SET is_active=true RETURNING id`,
    );
    mainUnitId = unit.rows[0]!.id;
    const product = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.products (environment,product_code,product_name,product_type)
       VALUES ('test',$1,'Pneu Etapa 4','tire') RETURNING id`, [`ET4-${Date.now()}`],
    );
    productId = product.rows[0]!.id;
    const contact = await db.pool.query<{ id: string }>(
      `INSERT INTO core.contacts (environment,chatwoot_contact_id,name)
       VALUES ('test',$1,'Cliente Etapa 4') RETURNING id`, [800_000_000 + Date.now() % 1_000_000],
    );
    contactId = contact.rows[0]!.id;
    buyerId = (await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.wholesale_customers (environment,name) VALUES ('test','Comprador Etapa 4') RETURNING id`,
    )).rows[0]!.id;
    supplierId = (await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.wholesale_suppliers (environment,name) VALUES ('test','Fornecedor Etapa 4') RETURNING id`,
    )).rows[0]!.id;
    partnerId = (await db.pool.query<{ id: string }>(
      `INSERT INTO network.partners (environment,legal_name,trade_name,status)
       VALUES ('test','Parceiro Etapa 4','Parceiro Etapa 4','active') RETURNING id`,
    )).rows[0]!.id;
  }, 180_000);

  afterAll(async () => { if (db) await stopPostgres(db); });

  async function retail(input: {
    total: string; item: string; cost: string | null; status: string;
    mode: 'pickup' | 'delivery'; payment: string; cancelled?: boolean;
  }): Promise<void> {
    const row = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.orders
         (environment,contact_id,total_amount,status,fulfillment_mode,payment_method,
          delivery_address,unit_id,closed_at,delivery_status,delivered_at)
       VALUES ('test',$1,$2,$3,$4,$5,$6,$7,
          CASE WHEN $3 IN ('confirmed','paid','delivered') THEN now() ELSE NULL END,
          CASE WHEN $4='delivery' AND $3='delivered' THEN 'delivered' ELSE 'pending' END,
          CASE WHEN $4='delivery' AND $3='delivered' THEN now() ELSE NULL END)
       RETURNING id`,
      [contactId, input.total, input.cancelled ? 'cancelled' : input.status, input.mode,
       input.payment, input.mode === 'delivery' ? 'Rua Etapa 4, 1' : null, mainUnitId],
    );
    await db.pool.query(
      `INSERT INTO commerce.order_items
         (environment,order_id,product_id,quantity,unit_price,discount_amount,matriz_unit_cost)
       VALUES ('test',$1,$2,1,$3,0,$4)`,
      [row.rows[0]!.id, productId, input.item, input.cost],
    );
  }

  async function wholesale(total: string, cost: string, payment: 'paid' | 'pending'): Promise<void> {
    const order = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.wholesale_orders
         (environment,buyer_id,total_amount,status,payment_status,paid_at,created_by)
       VALUES ('test',$1,$2,'confirmed',$3,CASE WHEN $3='paid' THEN now() ELSE NULL END,'etapa4')
       RETURNING id`, [buyerId, total, payment],
    );
    await db.pool.query(
      `INSERT INTO commerce.wholesale_order_items
         (environment,order_id,measure,quantity,unit_price,unit_cost)
       VALUES ('test',$1,'90/90-18',1,$2,$3)`,
      [order.rows[0]!.id, total, cost],
    );
  }

  async function purchase(total: string, payment: 'paid' | 'pending'): Promise<void> {
    const purchase = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.wholesale_purchases
         (environment,supplier_id,total_amount,status,payment_status,paid_at,created_by)
       VALUES ('test',$1,$2,'confirmed',$3,CASE WHEN $3='paid' THEN now() ELSE NULL END,'etapa4')
       RETURNING id`, [supplierId, total, payment],
    );
    await db.pool.query(
      `INSERT INTO commerce.wholesale_purchase_items
         (environment,purchase_id,measure,quantity,unit_cost)
       VALUES ('test',$1,'90/90-18',1,$2)`, [purchase.rows[0]!.id, total],
    );
  }

  it('separa competência, custo pendente, caixa e cancelamentos centavo a centavo', async () => {
    await retail({ total: '100.10', item: '100.10', cost: '60.05', status: 'confirmed', mode: 'pickup', payment: 'Pix' });
    await retail({ total: '120.21', item: '100.11', cost: null, status: 'delivered', mode: 'delivery', payment: 'Pix' });
    await retail({ total: '33.33', item: '33.33', cost: '10.00', status: 'open', mode: 'delivery', payment: 'Pix' });
    await retail({ total: '999.99', item: '999.99', cost: null, status: 'cancelled', mode: 'pickup', payment: 'Pix', cancelled: true });
    await wholesale('200.20', '100.10', 'paid');
    await wholesale('50.50', '20.20', 'pending');
    await purchase('80.08', 'paid');
    await purchase('30.03', 'pending');
    await db.pool.query(
      `INSERT INTO network.commission_entries
         (environment,partner_id,unit_id,partner_order_id,order_total,commission_percent,
          commission_amount,status,realized_at,settled_at)
       VALUES
         ('test',$1,$2,gen_random_uuid(),100.10,10,10.01,'settled',now(),now()),
         ('test',$1,$2,gen_random_uuid(),50.50,10,5.05,'open',now(),NULL)`,
      [partnerId, mainUnitId],
    );
    await db.pool.query(
      `INSERT INTO commerce.matriz_expenses
         (environment,category,description,amount,payment_status,paid_at,created_by)
       VALUES ('test','outros','Etapa 4 paga',20.02,'paid',now(),'etapa4'),
              ('test','outros','Etapa 4 pendente',7.07,'pending',NULL,'etapa4')`,
    );

    const truth = await getTruth('test', db.pool);
    expect(truth.competencia).toMatchObject({
      receita_total: '519.40', receita_custo_conhecido: '419.29',
      receita_custo_pendente: '100.11', custo_conhecido: '190.35',
      despesas: '27.09', lucro_confirmado: '201.85', status: 'custo_pendente',
    });
    expect(truth.caixa).toMatchObject({
      entradas_registradas: '430.52', saidas_registradas: '100.10',
      movimento_liquido: '330.42', recebimento_pendente: '33.33',
    });
    expect(truth.posicao).toMatchObject({ a_receber: '55.55', a_pagar: '37.10' });
    expect(truth.conciliacao.custo_pendente).toMatchObject({ receita: '100.11', itens: 1, pedidos: 1 });
    expect(truth.conciliacao.cancelamentos.varejo).toBe(1);
    expect(truth.conciliacao.origens.every((row) => row.diferenca === '0.00')).toBe(true);
  });
});
