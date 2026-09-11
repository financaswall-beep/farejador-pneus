import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';
import { importVehicleApplications, buildApplicationImport } from '../../scripts/vehicle-application-import.js';
import { loadVehicleApplicationCatalog, matchCatalogApplications } from '../../src/shared/vehicle-application-catalog.js';
import { createPartnerFixture } from './helpers/partner-fixtures.js';

let db: IntegrationDb;
beforeAll(async()=>{db=await startPostgres();},180_000);
afterAll(async()=>{if(db)await stopPostgres(db);},30_000);
describe('importação real do catálogo técnico',()=>{
  it('importa de forma idempotente, isolada e sem escrever produtos/estoque/fitments',async()=>{
    const client=await db.pool.connect();
    try {
      const counts=()=>client.query(`SELECT (SELECT count(*) FROM commerce.products) products,
        (SELECT count(*) FROM commerce.vehicle_fitments) fitments,
        (SELECT count(*) FROM commerce.wholesale_stock) stock`);
      const before=(await counts()).rows;
      await client.query('BEGIN');
      const result=await importVehicleApplications(client,'test');
      expect(result.inserted).toBe(buildApplicationImport().length);
      expect((await importVehicleApplications(client,'test')).inserted).toBe(0);
      expect((await counts()).rows).toEqual(before);
      const apps=await loadVehicleApplicationCatalog(client,'test');
      expect(apps.length).toBe(result.verified);
      expect(await loadVehicleApplicationCatalog(client,'prod')).toEqual([]);
      expect(matchCatalogApplications(apps,'NMAX',2018,'rear')[0]?.tire_size).toBe('130/70-13');
      expect(apps.some(a=>a.application_id.startsWith('claude-'))).toBe(false);
      expect((await client.query(`SELECT count(*)::int n FROM commerce.vehicle_measure_applications
        WHERE status='pending' AND application_kind='alternative'`)).rows[0].n).toBe(5);
      await client.query('ROLLBACK');
    } finally {client.release();}
  },30_000);
  it('banco recusa intervalo invertido e referência original sem fonte',async()=>{
    const sql=`INSERT INTO commerce.vehicle_measure_applications(environment,application_id,make,model,
      position,tire_size,display_measure,year_start,year_end,status,application_kind,reference,import_batch)
      VALUES ('test','invalid','Teste','Moto','rear','130/70-13','130/70-13',$1,$2,'verified','original',$3,'test')`;
    await expect(db.pool.query(sql,[2026,2016,{source_url:'https://example.com'}])).rejects.toThrow();
    await expect(db.pool.query(sql,[2016,2026,{}])).rejects.toThrow();
  });
  it('parceiro só lê referências verificadas do seu ambiente e não pode alterá-las',async()=>{
    const partner=await createPartnerFixture(db.pool);
    const client=await db.pool.connect();
    try {
      await client.query('BEGIN');
      await importVehicleApplications(client,'prod');
      const imported=await importVehicleApplications(client,'test');
      await client.query('SET LOCAL ROLE farejador_partner_app');
      expect((await client.query('SELECT * FROM commerce.vehicle_measure_applications')).rows).toEqual([]);
      await client.query("SELECT set_config('app.partner_unit_id',$1,true)",[partner.partnerUnitId]);
      const rows=(await client.query('SELECT environment,status FROM commerce.vehicle_measure_applications')).rows;
      expect(rows).toHaveLength(imported.verified);
      expect(rows.every(r=>r.environment==='test'&&r.status==='verified')).toBe(true);
      await expect(client.query("UPDATE commerce.vehicle_measure_applications SET status='verified'"))
        .rejects.toThrow();
      await client.query('ROLLBACK');
    } finally {client.release();}
  },30_000);
});
