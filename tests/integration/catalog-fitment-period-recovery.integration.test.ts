import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { applyMigrationFile, startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

let db: IntegrationDb;
beforeAll(async () => { db = await startPostgres({ throughMigration: '0293_dot_conversation_operations.sql' }); }, 180_000);
afterAll(async () => { if (db) await stopPostgres(db); });

it('restaura o vínculo sobrescrito e preserva um produto que já recebeu correção posterior', async () => {
  const vehicle = randomUUID();
  const older = randomUUID(), newer = randomUUID();
  const specs = [randomUUID(), randomUUID()], links = [randomUUID(), randomUUID()];
  // Banco descartável. A recuperação é intencionalmente limitada ao ambiente e às evidências do incidente.
  await db.pool.query(`INSERT INTO commerce.vehicle_models(id,environment,vehicle_type,make,model)
    VALUES ($1,'prod','motorcycle','Honda','CB 250F Twister')`, [vehicle]);
  for (const [i, spec] of specs.entries()) {
    const product = randomUUID();
    await db.pool.query(`INSERT INTO commerce.products(id,environment,product_code,product_type,product_name,brand,tire_condition)
      VALUES ($1,'prod',$2,'tire',$2,$2,'novo')`, [product, 'fixture-' + i]);
    await db.pool.query(`INSERT INTO commerce.tire_specs(id,environment,product_id,tire_size,vehicle_type)
      VALUES ($1,'prod',$2,'140/70-17','motorcycle')`, [spec, product]);
    await db.pool.query(`INSERT INTO commerce.vehicle_fitments(id,environment,vehicle_model_id,tire_spec_id,position,
      year_start,year_end,is_oem,source,confidence_level,updated_at)
      VALUES ($1,'prod',$2,$3,'rear',2022,2022,false,'discovery_promoted',0.8,$4)`,
    [links[i], vehicle, spec, i === 0 ? '2026-11-18T04:19:00Z' : '2026-11-19T10:00:00Z']);
  }
  for (const [id, start, end, reviewed] of [[older,2016,2017,'2026-11-18T04:12:00Z'],[newer,2022,2022,'2026-11-18T04:19:00Z']]) {
    await db.pool.query(`INSERT INTO commerce.fitment_discoveries(id,environment,vehicle_model_id,tire_spec_id,position,status,
      reviewed_by,reviewed_at,promoted_to_fitment_id,suggested_year_start,suggested_year_end,source_url)
      VALUES ($1,'prod',$2,$3,'rear','promoted','fixture',$4,$5,$6,$7,$8)`,[id,vehicle,specs[0],reviewed,links[0],start,end,
      id === older ? 'https://www.honda.com.br/motos/sites/hda/files/2017-05/Folheto%20Twister_Ok.pdf'
        : 'https://saladeimprensa.honda.com.br/releases/honda-cb-twister-2022-lider-da-categoria']);
    await db.pool.query(`INSERT INTO commerce.fitment_discovery_promotions(environment,discovery_id,fitment_id)
      SELECT 'prod',$1,f FROM unnest($2::uuid[]) f`, [id,links]);
  }
  await applyMigrationFile(db.pool, '0294_catalog_fitment_periods.sql');
  const rows = await db.pool.query(`SELECT tire_spec_id,year_start,year_end FROM commerce.vehicle_fitments
    WHERE environment='prod' AND vehicle_model_id=$1 ORDER BY year_start`, [vehicle]);
  expect(rows.rows).toHaveLength(3);
  expect(rows.rows.filter(row => row.year_start===2016)).toEqual([{tire_spec_id:specs[0],year_start:2016,year_end:2017}]);
  const pointers = await db.pool.query(`SELECT d.id,vf.year_start FROM commerce.fitment_discoveries d
    JOIN commerce.vehicle_fitments vf ON vf.id=d.promoted_to_fitment_id WHERE d.id=ANY($1::uuid[])`, [[older,newer]]);
  expect(pointers.rows).toEqual(expect.arrayContaining([{id:older,year_start:2016},{id:newer,year_start:2022}]));
  expect((await db.pool.query("SELECT 1 FROM audit.events WHERE event_type='catalog_fitment_period_restored'")).rowCount).toBe(1);
});
