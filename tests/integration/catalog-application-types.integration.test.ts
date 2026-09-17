import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';
import { importVehicleApplications } from '../../scripts/vehicle-application-import.js';
import { repairVehicleApplicationTypes } from '../../scripts/vehicle-application-type-repair.js';
let db: IntegrationDb;
beforeAll(async()=>{
  db=await startPostgres();
  Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:db.connectionString,CHATWOOT_HMAC_SECRET:'test',ADMIN_AUTH_TOKEN:'test'});
},180000);
afterAll(async()=>{if(db)await stopPostgres(db);});
describe('aplicações automáticas ao cadastrar 90/90-18 como Moto',()=>{
  it('restaura as referências antigas na ficha e na listagem sem alterar estoque ou homologar SKU',async()=>{
    const c=await db.pool.connect();
    try {await c.query('BEGIN');await importVehicleApplications(c,'test');await c.query("UPDATE commerce.vehicle_measure_applications SET vehicle_type=NULL WHERE environment='test'");await c.query('COMMIT');}finally{c.release();}
    await db.pool.query(`INSERT INTO commerce.wholesale_stock(environment,measure,brand,tire_condition,vehicle_type,quantity_on_hand,quantity_reserved,unit_cost)
      VALUES('test','90/90-18','Pirelli','meia_vida','motorcycle',1,0,30)`);
    const {createCatalogProductFromStock}=await import('../../src/admin/painel/queries-catalogo-create-stock.js');
    const {getCatalogCompatibility}=await import('../../src/admin/painel/queries-catalogo-compatibilidade.js');
    const {getCatalogOverview}=await import('../../src/admin/painel/queries-catalogo.js');
    const p=await createCatalogProductFromStock({environment:'test',measure:'90/90-18',brand:'Pirelli',tireCondition:'meia_vida',vehicleType:'motorcycle',position:'rear',productCode:'PIR-909018-MV',productName:'Pneu Pirelli 90/90-18',actorLabel:'integration'},db.pool);
    const before=(await db.pool.query('SELECT * FROM commerce.wholesale_stock')).rows;
    expect((await getCatalogCompatibility(p.product_id,'test',db.pool)).applications).toHaveLength(0);
    const tx=await db.pool.connect();try{
      await tx.query('BEGIN READ ONLY');const plan=await repairVehicleApplicationTypes(tx,'test','90/90-18');expect(plan.applications).toHaveLength(5);expect(plan.changed).toBe(0);await tx.query('ROLLBACK');
      await tx.query('BEGIN');expect((await repairVehicleApplicationTypes(tx,'test','90/90-18',true)).changed).toBe(5);await tx.query('COMMIT');
      await tx.query('BEGIN');expect((await repairVehicleApplicationTypes(tx,'test','90/90-18',true)).changed).toBe(0);await tx.query('COMMIT');
    }finally{tx.release();}
    const compatibility=await getCatalogCompatibility(p.product_id,'test',db.pool);
    expect(compatibility.applications).toHaveLength(5);expect(compatibility.rows).toEqual([]);
    expect(compatibility.applications.every(a=>a.product_fitment_confirmed===false)).toBe(true);
    expect((await getCatalogOverview('test',db.pool,'motorcycle')).rows.find((r:any)=>r.product_id===p.product_id)).toMatchObject({application_count:5,official_quantity_on_hand:1,official_quantity_reserved:0});
    expect((await db.pool.query('SELECT * FROM commerce.wholesale_stock')).rows).toEqual(before);
    expect((await db.pool.query("SELECT count(*)::int n FROM audit.events WHERE event_type='catalog_application_vehicle_type_repaired'")).rows[0].n).toBe(5);
    expect((await db.pool.query("SELECT count(*)::int n FROM commerce.vehicle_measure_applications WHERE environment='test' AND status<>'verified' AND vehicle_type IS NOT NULL")).rows[0].n).toBe(0);
  });
  it('importa referências com categoria e não reclassifica outra origem, fonte alterada, pendências ou outro ambiente',async()=>{
    const c=await db.pool.connect();try{
      await c.query('BEGIN');await importVehicleApplications(c,'prod');
      expect((await c.query("SELECT count(*)::int n FROM commerce.vehicle_measure_applications WHERE environment='prod' AND status='verified' AND vehicle_type IS NULL")).rows[0].n).toBe(0);
      await c.query("UPDATE commerce.vehicle_measure_applications SET vehicle_type=NULL WHERE environment='prod' AND display_measure='90/90-18'");
      await c.query("UPDATE commerce.vehicle_measure_applications SET vehicle_type='car' WHERE environment='prod' AND application_id='M001:rear:90/90-18'");
      await c.query("UPDATE commerce.vehicle_measure_applications SET reference=jsonb_set(reference,'{source_url}','\"https://example.com/alterada\"') WHERE environment='prod' AND application_id='M002:rear:90/90-18'");
      await c.query("UPDATE commerce.vehicle_measure_applications SET import_batch='other' WHERE environment='prod' AND application_id='M004:rear:90/90-18'");
      const fixed=await repairVehicleApplicationTypes(c,'prod','90/90-18',true);expect(fixed.changed).toBe(2);expect(fixed.skipped).toEqual(['M002:rear:90/90-18']);
      expect((await repairVehicleApplicationTypes(c,'test','90/90-18',true)).changed).toBe(0);
      expect((await c.query("SELECT vehicle_type FROM commerce.vehicle_measure_applications WHERE environment='prod' AND application_id='M001:rear:90/90-18'")).rows[0].vehicle_type).toBe('car');
      await c.query('ROLLBACK');
    }finally{c.release();}
  });
});
