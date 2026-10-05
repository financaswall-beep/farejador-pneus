import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPartnerFixture, type PartnerFixture } from './helpers/partner-fixtures.js';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

let db: IntegrationDb; let client: PoolClient; let own: PartnerFixture; let other: PartnerFixture;
let native = 910_000_000;
beforeAll(async () => {
  db = await startPostgres(); own = await createPartnerFixture(db.pool, { initialStockQty: 0 });
  other = await createPartnerFixture(db.pool, { initialStockQty: 0 });
  client = await db.pool.connect();
}, 360_000);
afterAll(async () => { client?.release(); if (db) await stopPostgres(db); });
beforeEach(async () => {
  await client.query('BEGIN');
  await client.query("UPDATE commerce.partner_stock_levels SET tire_size='90/90-18',tire_condition='meia_vida' WHERE id=$1", [own.stockId]);
  await client.query(`INSERT INTO commerce.wholesale_stock
    (environment,measure,brand,tire_condition,quantity_on_hand,quantity_reserved)
    VALUES('test','90/90-18','Pirelli','meia_vida',10,2)`);
});
afterEach(async () => { await client.query('ROLLBACK'); });

async function conversation(environment = 'test', demo = false) {
  return (await client.query(`INSERT INTO core.conversations
    (environment,chatwoot_conversation_id,chatwoot_account_id,current_status,started_at,additional_attributes)
    VALUES($1,$2,2,'open',now(),$3::jsonb) RETURNING id`,
  [environment, ++native, JSON.stringify(demo ? { farejador_simulator: true } : {})])).rows[0].id;
}
async function search(input: { unit?: PartnerFixture; conversation?: string; measure?: string; environment?: string;
  condition?: string; available?: boolean; at?: string; brand?: string; demo?: boolean } = {}) {
  const environment = input.environment ?? 'test';
  const id = input.conversation ?? await conversation(environment, input.demo);
  await client.query(`INSERT INTO ops.bot_stock_searches
    (environment,conversation_id,search_key,tool_name,measure,filters,stores,occurred_at)
    VALUES($1,$2,$3,'buscar_produto',$4,$5::jsonb,$6::jsonb,COALESCE($7::timestamptz,now()))`,
  [environment, id, randomUUID(), input.measure ?? '90/90-18',
    JSON.stringify({ condicao_pneu: input.condition ?? 'meia_vida', ...(input.brand ? { marca: input.brand } : {}) }),
    JSON.stringify([{ id: (input.unit ?? own).unitId, available: input.available ?? false }]), input.at ?? null]);
  return id;
}
async function restricted(sql: string, unit: PartnerFixture | null = own) {
  await client.query('SAVEPOINT partner_read');
  try {
    await client.query('SET LOCAL ROLE farejador_partner_app');
    await client.query("SELECT set_config('app.partner_unit_id',$1,true)", [unit?.partnerUnitId ?? '']);
    return (await client.query(sql)).rows;
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT partner_read'); await client.query('RELEASE SAVEPOINT partner_read');
  }
}
const offers = (unit: PartnerFixture | null = own) => restricted('SELECT * FROM commerce.partner_replenishment_offers()', unit);

describe('Reposição do parceiro — PostgreSQL e role restrita', () => {
  it('conta uma conversa uma vez, desconta reservas e oculta os dados internos', async () => {
    const id = await search(); await search({ conversation: id }); await search();
    const rows = await offers(); expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ measure: '90/90-18', demand_count: 2, quantity_available: 8, brand: 'Pirelli' });
    expect(Object.keys(rows[0]).sort()).toEqual(['brand','demand_count','last_demand_at','measure','quantity_available','tire_condition','vehicle_type'].sort());
    expect(await offers(other)).toEqual([]); expect(await offers(null)).toEqual([]);
    await expect(restricted('SELECT * FROM ops.bot_stock_searches')).rejects.toThrow(/permission denied/);
    await expect(restricted('SELECT unit_cost FROM commerce.wholesale_stock')).rejects.toThrow(/permission denied/);
  });
  it('não mostra procura de outra loja, outro ambiente, simulação, estoque disponível ou fora da janela', async () => {
    await search({ unit: other }); await search({ environment: 'prod' }); await search({ demo: true });
    await search({ available: true }); await search({ at: new Date(Date.now() - 8 * 86400_000).toISOString() });
    expect(await offers()).toEqual([]);
  });
  it('oculta após reposição local ou fim do saldo livre no galpão', async () => {
    await search(); expect(await offers()).toHaveLength(1);
    await client.query('UPDATE commerce.partner_stock_levels SET quantity_on_hand=1 WHERE id=$1', [own.stockId]);
    expect(await offers()).toEqual([]);
    await client.query('UPDATE commerce.partner_stock_levels SET quantity_on_hand=0 WHERE id=$1', [own.stockId]);
    await client.query("UPDATE commerce.wholesale_stock SET quantity_reserved=quantity_on_hand WHERE environment='test'");
    expect(await offers()).toEqual([]);
  });
  it('respeita a condição e a marca que faltaram, sem sugerir uma variante diferente', async () => {
    await search({ condition: 'novo' }); await search({ brand: 'Michelin' });
    expect(await offers()).toEqual([]);
    await search({ brand: 'Pirelli' }); expect(await offers()).toHaveLength(1);
  });
  it('aceita NÃO TENHO para uma medida, sem atribuir a falta a todas as medidas de um conjunto', async () => {
    const id = await conversation();
    const insert = async (items: unknown[]) => client.query(`INSERT INTO commerce.partner_stock_requests
      (environment,conversation_id,unit_id,basket_key,items,routing,sealed,status,answered_at)
      VALUES('test',$1,$2,$3,$4::jsonb,'{}',true,'rejected',now())`, [id, own.unitId, randomUUID(), JSON.stringify(items)]);
    const item = { tire_size: '90/90-18', tire_condition: 'meia_vida', quantity: 1 };
    await insert([item, { ...item, tire_size: '80/100-14' }]); expect(await offers()).toEqual([]);
    await insert([item]); expect((await offers())[0]).toMatchObject({ demand_count: 1, quantity_available: 8 });
  });
  it('escolhe uma única medida pela maior procura, sem oferecer a segunda', async () => {
    await search(); await search(); await search({ measure: '80/100-14' });
    await client.query(`INSERT INTO commerce.wholesale_stock (environment,measure,brand,tire_condition,quantity_on_hand)
      VALUES('test','80/100-14','Pirelli','meia_vida',20)`);
    expect((await offers()).map(row => row.measure)).toEqual(['90/90-18']);
  });
});
