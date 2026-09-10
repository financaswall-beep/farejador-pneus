import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';
import { createPartnerFixture } from './helpers/partner-fixtures.js';
import { salesReportQuery } from '../../src/admin/painel/sales-report-period.js';
let db: IntegrationDb, matrix: string, otherUnit: string, contact: string, buyer: string, tire: string, unknown: string, service: string;
let getReport: typeof import('../../src/admin/painel/queries-sales-report.js').getSalesReport;
const filters=salesReportQuery.parse({from:'2026-09-01',to:'2026-09-10'});
async function retail(at:string,status='confirmed',unit=matrix) {
  const id=(await db.pool.query(`INSERT INTO commerce.orders(environment,contact_id,unit_id,total_amount,status,fulfillment_mode,idempotency_key,created_at,delivery_address)
    VALUES('test',$1,$2,235,$3,'delivery',$4,$5,'Endereço fictício do teste') RETURNING id`,[contact,unit,status,randomUUID(),at])).rows[0].id;
  await db.pool.query(`INSERT INTO commerce.order_items(environment,order_id,product_id,quantity,unit_price,discount_amount,matriz_unit_cost,tire_condition)
    VALUES('test',$1,$2,2,100,10,60,'novo'),('test',$1,$3,1,30,0,5,NULL)`,[id,tire,service]);
  return id;
}
beforeAll(async()=>{
  db=await startPostgres();
  for(const [key,value] of Object.entries({DATABASE_URL:db.connectionString,FAREJADOR_ENV:'test',CHATWOOT_HMAC_SECRET:'test-secret',ADMIN_AUTH_TOKEN:'test-secret'}))vi.stubEnv(key,value);
  ({getSalesReport:getReport}=await import('../../src/admin/painel/queries-sales-report.js'));
  matrix=(await db.pool.query(`INSERT INTO core.units(environment,slug,name) VALUES('test','main','Matriz') ON CONFLICT(environment,slug) DO UPDATE SET name=EXCLUDED.name RETURNING id`)).rows[0].id;
  otherUnit=(await db.pool.query(`INSERT INTO core.units(environment,slug,name) VALUES('test','report-other','Outra unidade') RETURNING id`)).rows[0].id;
  contact=(await db.pool.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id) VALUES('test',998878) RETURNING id`)).rows[0].id;
  buyer=(await db.pool.query(`INSERT INTO commerce.wholesale_customers(environment,name) VALUES('test','Comprador relatório') RETURNING id`)).rows[0].id;
  const partner=await createPartnerFixture(db.pool);
  await db.pool.query('UPDATE commerce.wholesale_customers SET partner_id=$1 WHERE id=$2',[partner.partnerId,buyer]);
  const product=async(code:string,kind:string,brand:string|null)=> (await db.pool.query(`INSERT INTO commerce.products(environment,product_code,product_name,product_type,brand,tire_condition)
    VALUES('test',$1,$1,$2,$3,CASE WHEN $2='tire' THEN CASE WHEN $1='UnknownCost' THEN 'meia_vida' ELSE 'novo' END END) RETURNING id`,[code,kind,brand])).rows[0].id;
  tire=await product('TireReport','tire','Pirelli');unknown=await product('UnknownCost','tire','Michelin');service=await product('Montagem','service',null);
  await db.pool.query(`INSERT INTO commerce.tire_specs(environment,product_id,tire_size) VALUES('test',$1,'90/90-12'),('test',$2,'130/70-13')`,[tire,unknown]);
  await retail('2026-09-01T03:00:00Z');
  await retail('2026-09-01T02:59:59Z'); // São Paulo: August 31, outside both periods.
  await retail('2026-09-11T03:00:00Z');
  await retail('2026-09-02T10:00:00Z','cancelled');
  await retail('2026-09-02T10:00:00Z','open');
  await retail('2026-09-02T10:00:00Z','confirmed',otherUnit);
  await retail('2026-08-01T03:00:00Z');
  const pending=(await db.pool.query(`INSERT INTO commerce.orders(environment,contact_id,unit_id,total_amount,status,fulfillment_mode,idempotency_key,created_at)
    VALUES('test',$1,$2,200,'confirmed','pickup',$3,'2026-09-02T10:00:00Z') RETURNING id`,[contact,matrix,randomUUID()])).rows[0].id;
  await db.pool.query(`INSERT INTO commerce.order_items(environment,order_id,product_id,quantity,unit_price,tire_condition)
    VALUES('test',$1,$2,1,200,'meia_vida')`,[pending,unknown]);
  for(const transfer of [null,'in_transit','settled']){
    const id=(await db.pool.query(`INSERT INTO commerce.wholesale_orders(environment,buyer_id,sold_at,status,total_amount,partner_transfer_status,partner_settled_at,
      partner_unit_id,dispatched_total_amount,settled_total_amount,partner_payment_terms,payment_status)
      VALUES('test',$1,'2026-09-03T10:00:00Z',CASE WHEN $2='in_transit' THEN 'pending' ELSE 'confirmed' END,400,$2,
        CASE WHEN $2='settled' THEN '2026-09-05T10:00:00Z'::timestamptz END,
        $3,CASE WHEN $2 IS NOT NULL THEN 400 END,CASE WHEN $2='settled' THEN 200 END,
        CASE WHEN $2 IS NOT NULL THEN 'credit' END,'pending') RETURNING id`,[buyer,transfer,transfer?partner.partnerUnitId:null])).rows[0].id;
    const client=await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL app.matrix_partner_arrival='on'");
      await client.query(`INSERT INTO commerce.wholesale_order_items(environment,order_id,measure,brand,tire_condition,quantity,accepted_quantity,unit_price,unit_cost)
        VALUES('test',$1,'90/90-12','Pirelli','novo',4,$2,100,60)`,[id,transfer==='settled'?2:null]);
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
},180000);
afterAll(async()=>{vi.unstubAllEnvs();if(db)await stopPostgres(db);});
describe('relatório da Matriz no PostgreSQL real',()=>{
  it('isola Matriz/ambiente, ignora canceladas e trânsito e usa apenas quantidades aceitas',async()=>{
    const report=await getReport(filters,true,'test',db.pool);
    expect(report.summary).toMatchObject({revenue:1020,orders:4,tires:9,units:10,margin:null,cost:null,pending_cost_lines:1,known_cost:485,known_margin:335});
    expect(report.channels.find(row=>row.channel==='atacado')).toMatchObject({revenue:600,tires:6,margin:240});
    expect(report.previous).toMatchObject({revenue:220,orders:1});
    expect((await getReport(filters,true,'prod',db.pool)).summary.orders).toBe(0);
  });
  it('aplica marca/condição/medida aos dois períodos e não troca custo histórico pelo atual',async()=>{
    const filter={...filters,brand:'Pirelli',condition:'novo' as const,measure:'90/90-12',exact:'true' as const};
    const before=await getReport(filter,true,'test',db.pool);
    await db.pool.query(`INSERT INTO commerce.wholesale_stock(environment,measure,brand,tire_condition,quantity_on_hand,unit_cost)
      VALUES('test','90/90-12','Pirelli','novo',99,9999)`);
    const after=await getReport(filter,true,'test',db.pool);
    expect(after.summary).toEqual(before.summary);
    expect(after.summary).toMatchObject({revenue:790,tires:8,orders:3,cost:480,margin:310});
    expect(after.previous).toMatchObject({revenue:190,margin:70});
    expect(after.measures).toHaveLength(1);expect(after.export_sales).toHaveLength(3);
  });
  it('protege custos no payload e mantém o detalhe limitado aos filtros',async()=>{
    const report=await getReport({...filters,channel:'varejo',brand:'Pirelli'},false,'test',db.pool);
    expect(report.summary.revenue).toBe(190);expect(report.summary.cost).toBeNull();
    expect(report.products.every(row=>row.cost===null&&row.margin===null)).toBe(true);
    expect(report.sales.rows[0].items).toHaveLength(1);
    expect(report.sales.rows[0].items[0]).toMatchObject({measure:'90/90-12',cost:null,margin:null});
    expect(report.summary.known_margin).toBeNull();
  });
});
