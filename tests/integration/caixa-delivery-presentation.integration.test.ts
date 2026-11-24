import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';
import type { CaixaAuth } from '../../src/admin/caixa/queries.js';

describe('apresentação e referência do avatar das entregas', () => {
  let db: IntegrationDb, main: string, otherUnit: string, contact: string, conversation: string, sequence = 996500;
  let read: typeof import('../../src/admin/caixa/delivery-presentation.js').getDeliveryPresentation;
  let auth: CaixaAuth, other: CaixaAuth;
  async function courier(name: string): Promise<CaixaAuth> {
    const person = (await db.pool.query(`INSERT INTO network.partner_people(environment,username)
      VALUES('test',$1) RETURNING id`, [name])).rows[0].id;
    const collaborator = (await db.pool.query(`INSERT INTO network.matriz_collaborators
      (environment,person_id,display_name,job,job_title,work_area)
      VALUES('test',$1,$2,'entregador','Entregador','delivery') RETURNING id`, [person, name])).rows[0].id;
    return { personId: person, collaboratorId: collaborator, displayName: name, username: name,
      job: 'entregador', modules: { entregas: true, estoque: false, vendas: false, financeiro: false, retiradas: false } };
  }
  async function order(unit = main, mode = 'delivery') {
    return (await db.pool.query(`INSERT INTO commerce.orders
      (environment,contact_id,source_conversation_id,unit_id,total_amount,fulfillment_mode,delivery_address)
      VALUES('test',$1,$2,$3,149.90,$4,'Rua de exemplo, 120') RETURNING id`, [contact, conversation, unit, mode])).rows[0].id as string;
  }
  async function trip(owner: CaixaAuth) {
    return (await db.pool.query(`INSERT INTO commerce.matriz_delivery_trips(environment,courier_name,courier_collaborator_id)
      VALUES('test',$1,$2) RETURNING id`, [owner.displayName, owner.collaboratorId])).rows[0].id as string;
  }
  beforeAll(async () => {
    Object.assign(process.env, { NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
      CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'test-token' });
    db = await startPostgres(); ({ getDeliveryPresentation: read } = await import('../../src/admin/caixa/delivery-presentation.js'));
    main = (await db.pool.query(`INSERT INTO core.units(environment,slug,name) VALUES('test','main','Matriz') RETURNING id`)).rows[0].id;
    otherUnit = (await db.pool.query(`INSERT INTO core.units(environment,slug,name) VALUES('test','other','Outra unidade') RETURNING id`)).rows[0].id;
    contact = (await db.pool.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name)
      VALUES('test',$1,'Cliente da entrega') RETURNING id`, [sequence++])).rows[0].id;
    conversation = (await db.pool.query(`INSERT INTO core.conversations
      (environment,chatwoot_conversation_id,chatwoot_account_id,contact_id,current_status,started_at)
      VALUES('test',$1,1,$2,'open',now()) RETURNING id`, [sequence++, contact])).rows[0].id;
    auth = await courier('delivery-presentation-a'); other = await courier('delivery-presentation-b');
  }, 180000);
  afterAll(async () => { if (db) await stopPostgres(db); });

  it('lê fila e itens exatos com categoria cadastrada, sem inferir veículo nem expor custo', async () => {
    const id = await order();
    for (const [code, type, size] of [['D-MOTO', 'motorcycle', '100/80-14'], ['D-CAR', 'car', '185/65R15'], ['D-UNKNOWN', null, '110/70-13']]) {
      const product = (await db.pool.query(`INSERT INTO commerce.products(environment,product_code,product_name,product_type,brand,tire_condition)
        VALUES('test',$1,$1,'tire','Marca','novo') RETURNING id`, [code])).rows[0].id;
      if (type) await db.pool.query(`INSERT INTO commerce.tire_specs(environment,product_id,tire_size,vehicle_type)
        VALUES('test',$1,$2,$3)`, [product, size, type]);
      await db.pool.query(`INSERT INTO commerce.order_items(environment,order_id,product_id,quantity,unit_price)
        VALUES('test',$1,$2,1,49.97)`, [id, product]);
    }
    const row = (await read(auth, [id], 'test', db.pool)).get(id)!;
    expect(row.conversation_id).toBe(conversation); expect(row.items).toHaveLength(3);
    expect(row.items.map(item => item.vehicle_type).sort()).toEqual(['car', 'motorcycle', null].sort());
    expect(JSON.stringify(row)).not.toMatch(/cost|margin|profit|api_token|password/);
  });
  it('rejeita outra unidade, retirada, cancelado, ambiente de produção e rota de outro operador', async () => {
    const foreign = await order(), cancelled = await order(), unit = await order(otherUnit), pickup = await order(main, 'pickup');
    const foreignTrip = await trip(other);
    await db.pool.query(`UPDATE commerce.orders SET trip_id=$2 WHERE id=$1`, [foreign, foreignTrip]);
    await db.pool.query(`UPDATE commerce.orders SET status='cancelled' WHERE id=$1`, [cancelled]);
    const ids = [foreign, cancelled, unit, pickup];
    expect((await read(auth, ids, 'test', db.pool)).size).toBe(0);
    expect((await read(auth, ids, 'prod', db.pool)).size).toBe(0);
  });
  it.each([false,true])('mostra a pilha baixada até expedir a venda avulsa, SKU repetido = %s', async repeated => {
    const { saveMatrizStockGroup } = await import('../../src/admin/painel/stock-groups.js');
    const { registerWalkinOrder } = await import('../../src/admin/painel/walkin-order.js');
    const measure = '235/55 R18', brand = repeated ? 'Marca com linhas repetidas' : 'Marca de teste';
    const product = (await db.pool.query(`INSERT INTO commerce.products
      (environment,product_code,product_name,product_type,brand,tire_condition)
      VALUES('test',$1,'Pneu de teste','tire',$2,'meia_vida') RETURNING id`, [randomUUID(), brand])).rows[0].id;
    await db.pool.query(`INSERT INTO commerce.tire_specs(environment,product_id,tire_size,vehicle_type)
      VALUES('test',$1,$2,'car')`, [product, measure]);
    await db.pool.query(`INSERT INTO commerce.matriz_product_prices(environment,product_id,price_amount)
      VALUES('test',$1,120)`, [product]);
    const stock = (await db.pool.query(`INSERT INTO commerce.wholesale_stock
      (environment,measure,brand,tire_condition,vehicle_type,quantity_on_hand,unit_cost)
      VALUES('test',$1,$2,'meia_vida','car',$3,50) RETURNING id`, [measure, brand, repeated ? 3 : 2])).rows[0].id;
    const locateOne = () => saveMatrizStockGroup(db.pool, 'test', { stock_id: stock, product_id: product,
      inspection_status: 'located', positions: [{ location_code: 'B2', quantity: 1 }],
      reason: 'Conferência de teste', idempotency_key: randomUUID() }, 'Teste');
    await locateOne();
    if (repeated) await locateOne();
    const { order_id } = await registerWalkinOrder({
      environment: 'test', customer_name: 'Cliente de teste', customer_phone: null, unit_id: main,
      items: (repeated ? [1,2] : [2]).map(quantity => ({ product_id: product, quantity, unit_price: 120, discount_amount: 0 })),
      payment_method: 'pix', fulfillment_mode: 'delivery', delivery_address: 'Rua de exemplo, 120',
      actor_label: 'Teste', idempotency_key: randomUUID(), source_tag: 'walkin_balcao',
    }, db.pool);
    const pending = (await read(auth, [order_id], 'test', db.pool)).get(order_id);
    expect(pending?.delivery_status).toBe('pending');
    if (repeated) {
      expect(pending!.items).toHaveLength(2);
      expect(pending!.items.every(item => !item.stock_positions)).toBe(true);
      expect(pending!.shared_stock_positions).toEqual([{ product_id: product, product_name: 'Pneu de teste',
        positions: [{ location_code: 'B2', quantity: 2, model: null }] }]);
    } else {
      expect(pending!.items).toMatchObject([{ quantity: 2, stock_positions: [{ location_code: 'B2', quantity: 1, model: null }] }]);
      expect(pending!.shared_stock_positions).toBeUndefined();
    }
    const ownTrip = await trip(auth);
    await db.pool.query(`UPDATE commerce.orders SET trip_id=$2,delivery_status='dispatched' WHERE id=$1`, [order_id, ownTrip]);
    const dispatched = (await read(auth, [order_id], 'test', db.pool)).get(order_id);
    expect(dispatched?.items[0]).toBeDefined();
    expect(dispatched!.items[0]).not.toHaveProperty('stock_positions');
    expect(dispatched!.shared_stock_positions).toBeUndefined();
    expect((await read(other, [order_id], 'test', db.pool)).size).toBe(0);
    await db.pool.query(`UPDATE commerce.matriz_delivery_trips SET status='closed',ended_at=now() WHERE id=$1`, [ownTrip]);
  });
  it('permite somente a rota aberta própria, incluindo problema informado, e revoga ao fechar', async () => {
    const id = await order(), ownTrip = await trip(auth);
    await db.pool.query(`UPDATE commerce.orders SET trip_id=$2,delivery_status='failed',delivery_failure_reason='Cliente ausente' WHERE id=$1`, [id, ownTrip]);
    expect((await read(auth, [id], 'test', db.pool)).get(id)?.delivery_failure_reason).toBe('Cliente ausente');
    expect((await read(other, [id], 'test', db.pool)).size).toBe(0);
    await db.pool.query(`UPDATE commerce.matriz_delivery_trips SET status='closed',ended_at=now() WHERE id=$1`, [ownTrip]);
    expect((await read(auth, [id], 'test', db.pool)).size).toBe(0);
  });
  it('não vincula avatar de contato diferente ou conversa excluída', async () => {
    const id = await order();
    const anotherContact = (await db.pool.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name)
      VALUES('test',$1,'Outra pessoa') RETURNING id`, [sequence++])).rows[0].id;
    await expect(db.pool.query(`UPDATE commerce.orders SET contact_id=$2 WHERE id=$1`, [id, anotherContact]))
      .rejects.toThrow('conversation_contact_mismatch');
    await db.pool.query(`UPDATE commerce.orders SET source_conversation_id=NULL WHERE id=$1`, [id]);
    expect((await read(auth, [id], 'test', db.pool)).get(id)?.conversation_id).toBeNull();
    await db.pool.query(`UPDATE commerce.orders SET source_conversation_id=$2 WHERE id=$1`, [id, conversation]);
    await db.pool.query(`UPDATE core.conversations SET deleted_at=now() WHERE id=$1`, [conversation]);
    expect((await read(auth, [id], 'test', db.pool)).get(id)?.conversation_id).toBeNull();
  });
});
