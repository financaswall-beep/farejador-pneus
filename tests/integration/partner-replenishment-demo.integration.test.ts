import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPartnerFixture, type PartnerFixture } from './helpers/partner-fixtures.js';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

let db: IntegrationDb; let client: PoolClient; let own: PartnerFixture; let other: PartnerFixture;
beforeAll(async () => {
  db = await startPostgres(); own = await createPartnerFixture(db.pool, { initialStockQty: 0 });
  other = await createPartnerFixture(db.pool, { initialStockQty: 0 }); client = await db.pool.connect();
}, 360_000);
afterAll(async () => { client?.release(); if (db) await stopPostgres(db); });
beforeEach(async () => {
  await client.query('BEGIN');
  await client.query("UPDATE network.partner_units SET slug='teste-app-parceiro-0410',accepts_network_orders=false WHERE id=$1", [own.partnerUnitId]);
  await client.query('UPDATE network.partners SET commission_percent=0 WHERE id=$1', [own.partnerId]);
  await client.query("UPDATE network.partner_access_tokens SET login_username='parceiro.teste' WHERE id=$1", [own.tokenId]);
  await client.query(`INSERT INTO commerce.wholesale_stock
    (environment,measure,brand,tire_condition,quantity_on_hand,quantity_reserved)
    VALUES ('test','150/70-14','Pirelli','meia_vida',4,1)`);
});
afterEach(async () => { await client.query('ROLLBACK'); });

async function event(input: { environment?: string; age?: string; payload?: unknown } = {}) {
  await client.query(`INSERT INTO audit.events
    (environment,domain,entity_table,entity_id,event_type,actor_label,idempotency_key,payload_after,created_at)
    VALUES ($1,'network','network.partner_units',$2,'partner_replenishment_demo_created','fixture',$3,$4::jsonb,
      now()-$5::interval)`, [input.environment ?? 'test', own.partnerUnitId, randomUUID(),
    JSON.stringify(input.payload ?? { simulation: true, measures: [{ measure: '150/70-14', tire_condition: 'meia_vida', demand_count: 3 }] }),
    input.age ?? '0 seconds']);
}
async function read(unit: PartnerFixture | null = own, sql = 'SELECT * FROM commerce.partner_replenishment_offers()') {
  await client.query('SAVEPOINT partner_read');
  try {
    await client.query('SET LOCAL ROLE farejador_partner_app');
    await client.query("SELECT set_config('app.partner_unit_id',$1,true)", [unit?.partnerUnitId ?? '']);
    return (await client.query(sql)).rows;
  } finally { await client.query('ROLLBACK TO SAVEPOINT partner_read'); await client.query('RELEASE SAVEPOINT partner_read'); }
}

describe('Demonstração de reposição isolada e temporária', () => {
  it('usa evento separado da procura e saldo livre real, sem dar acesso à auditoria', async () => {
    expect(await read()).toEqual([]); await event();
    expect(await read()).toEqual([expect.objectContaining({ measure: '150/70-14', demand_count: 3, quantity_available: 3 })]);
    await expect(read(own, 'SELECT * FROM audit.events')).rejects.toThrow(/permission denied/);
    await expect(read(own, 'SELECT * FROM commerce.partner_replenishment_live_offers()')).rejects.toThrow(/permission denied/);
    expect(await read(other)).toEqual([]); expect(await read(null)).toEqual([]);
  });
  it('exige unidade isolada, dono teste e comissão zero', async () => {
    await event();
    await client.query('UPDATE network.partner_units SET accepts_network_orders=true WHERE id=$1', [own.partnerUnitId]);
    expect(await read()).toEqual([]);
    await client.query('UPDATE network.partner_units SET accepts_network_orders=false WHERE id=$1', [own.partnerUnitId]);
    await client.query('UPDATE network.partners SET commission_percent=5 WHERE id=$1', [own.partnerId]);
    expect(await read()).toEqual([]);
    await client.query('UPDATE network.partners SET commission_percent=0 WHERE id=$1', [own.partnerId]);
    await client.query('UPDATE network.partner_access_tokens SET revoked_at=now() WHERE id=$1', [own.tokenId]);
    expect(await read()).toEqual([]);
  });
  it('ignora ambiente diferente, evento antigo e futura data', async () => {
    await event({ environment: 'prod' }); await event({ age: '3 hours' }); await event({ age: '-1 hour' });
    expect(await read()).toEqual([]);
  });
  it('encerra a demonstração por evento novo com lista vazia', async () => {
    await event({ age: '1 minute' }); await event({ payload: { simulation: true, measures: [] } });
    expect(await read()).toEqual([]);
  });
  it('não oferece medida reposta localmente ou sem saldo livre no galpão', async () => {
    await event();
    await client.query("UPDATE commerce.partner_stock_levels SET tire_size='150/70-14',tire_condition='meia_vida',quantity_on_hand=1 WHERE id=$1", [own.stockId]);
    expect(await read()).toEqual([]);
    await client.query('UPDATE commerce.partner_stock_levels SET quantity_on_hand=0 WHERE id=$1', [own.stockId]);
    await client.query("UPDATE commerce.wholesale_stock SET quantity_reserved=quantity_on_hand WHERE environment='test'");
    expect(await read()).toEqual([]);
  });
});
