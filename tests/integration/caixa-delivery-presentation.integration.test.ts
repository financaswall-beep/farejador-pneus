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
