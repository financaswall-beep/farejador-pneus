import { beforeAll,afterAll,describe,it,expect,vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startPostgres,stopPostgres,type IntegrationDb } from './helpers/postgres.js';
let db:IntegrationDb,serial=9896500;
let read:typeof import('../../src/admin/painel/demand-report-data.js').readDemandSnapshot;
let build:typeof import('../../src/admin/painel/queries-demand-report.js').buildDemandReport;
const f={from:'2026-09-01',to:'2026-09-11',mode:'month' as const,compare:'true' as const,city:'',citySearch:'',measure:'',search:'',view:'overview' as const,metric:'conversations' as const,grain:'day' as const,sort:'conversations' as const};
async function conv(environment='test'){
  const cw=++serial,contact=(await db.pool.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id) VALUES($1,$2) RETURNING id`,[environment,cw])).rows[0].id;
  const id=(await db.pool.query(`INSERT INTO core.conversations(environment,chatwoot_conversation_id,chatwoot_account_id,contact_id,current_status,started_at,last_activity_at)
    VALUES($1,$2,1,$3,'open',now(),now()) RETURNING id`,[environment,cw,contact])).rows[0].id;return{id,contact,environment};
}
async function fact(c:Awaited<ReturnType<typeof conv>>,key:string,value:unknown,at='2026-09-02T12:00:00Z',superseded:string|null=null){return(await db.pool.query(`INSERT INTO analytics.conversation_facts(environment,conversation_id,fact_key,fact_value,observed_at,truth_type,source,extractor_version,superseded_by)
  VALUES($1,$2,$3,$4::jsonb,$5,'observed','test',$6,$7) RETURNING id`,[c.environment,c.id,key,JSON.stringify(value),at,randomUUID(),superseded])).rows[0].id;}
async function trace(c:Awaited<ReturnType<typeof conv>>,measure:string,at:string,municipality:string|null='São Gonçalo'){
  await db.pool.query(`INSERT INTO ops.bot_stock_searches(environment,conversation_id,search_key,tool_name,occurred_at,measure,municipality,filters,stores)
    VALUES($1,$2,$3,'buscar_produto',$4,$5,$6,'{}','[{"id":"matriz","name":"Matriz","available":false}]')`,[c.environment,c.id,randomUUID(),at,measure,municipality]);
}
beforeAll(async()=>{
  db=await startPostgres();vi.stubEnv('DATABASE_URL',db.connectionString);vi.stubEnv('FAREJADOR_ENV','test');vi.stubEnv('CHATWOOT_HMAC_SECRET','test');vi.stubEnv('ADMIN_AUTH_TOKEN','test');
  read=(await import('../../src/admin/painel/demand-report-data.js')).readDemandSnapshot;build=(await import('../../src/admin/painel/queries-demand-report.js')).buildDemandReport;
},120000);
afterAll(async()=>{if(db){const {pool}=await import('../../src/persistence/db.js');await pool.end();await stopPostgres(db);}vi.unstubAllEnvs();});
describe('demanda regional no schema real',()=>{
  it('usa limites BRT, fatos vigentes e deduplicação entre trilha e analytics; leitura não altera o banco',async()=>{
    const a=await conv(),b=await conv(),unknown=await conv(),prod=await conv('prod');
    await fact(a,'municipio_entrega','SAO GONCALO');await fact(b,'municipio_entrega','Volta Redonda');
    const valid=await fact(a,'medida_consultada','90/90-12');await fact(a,'medida_consultada','180/55-17',undefined,valid);
    await trace(a,'90/90-12','2026-09-01T03:00:00Z');await trace(a,'90 90 12','2026-09-11T23:00:00Z');
    await trace(a,'110/70-17','2026-09-01T02:59:59Z');await trace(a,'130/70-13','2026-09-12T03:00:00Z');
    await trace(b,'180/55-17','2026-09-04T15:00:00Z','Volta Redonda');await trace(unknown,'90/90-12','2026-09-02T12:00:00Z',null);
    await trace(prod,'90/90-12','2026-09-02T12:00:00Z','Outra cidade');
    await db.pool.query(`INSERT INTO commerce.wholesale_stock(environment,measure,brand,tire_condition,quantity_on_hand,quantity_reserved,unit_cost)
      VALUES('test','90/90-12','A','novo',10,4,50),('test','90/90-12','B','novo',2,0,50),('prod','90/90-12','A','novo',900,0,50)`);
    const before=(await db.pool.query(`SELECT id,stores,filters,measure FROM ops.bot_stock_searches ORDER BY id`)).rows;
    const r=build(await read(f,'test',db.pool),f);expect(r.summary).toMatchObject({conversations:3,municipalities:2,unidentified:1,shortages:3});
    expect(r.measures.map(m=>m.measure)).toEqual(['90/90-12','180/55-17']);expect(r.measures[0]).toMatchObject({stock:12,consultations:2});expect(r.measures[1]?.stock).toBeNull();
    expect(r.cities.find(c=>c.name==='Volta Redonda')?.conversations).toBe(1);expect(JSON.stringify(r)).not.toContain(a.id);
    expect((await db.pool.query(`SELECT id,stores,filters,measure FROM ops.bot_stock_searches ORDER BY id`)).rows).toEqual(before);
    expect(build(await read(f,'prod',db.pool),f).summary.conversations).toBe(1);
  });
  it('não converte fatos antigos ou pedidos cancelados em pedidos do período; registra entrega pela sua data',async()=>{
    const a=await conv();await fact(a,'municipio_entrega','Maricá');await fact(a,'medida_consultada','130/70-13');await fact(a,'pedido_criado','old');
    for(const [status,at] of [['cancelled','2026-09-02T12:00:00Z'],['confirmed','2026-08-04T12:00:00Z']])await db.pool.query(`INSERT INTO commerce.orders(environment,contact_id,source_conversation_id,total_amount,status,fulfillment_mode,created_at)
      VALUES('test',$1,$2,100,$3,'pickup',$4)`,[a.contact,a.id,status,at]);
    const scoped={...f,city:'Maricá'};let r=build(await read(scoped,'test',db.pool),scoped);expect(r.scope.orders).toBe(0);expect(r.previous?.orders).toBe(1);
    await db.pool.query(`INSERT INTO commerce.orders(environment,contact_id,source_conversation_id,total_amount,status,fulfillment_mode,delivery_address,delivery_status,delivered_at,created_at)
      VALUES('test',$1,$2,100,'confirmed','delivery','Endereço fictício','delivered','2026-09-08T12:00:00Z','2026-08-04T12:00:00Z')`,[a.contact,a.id]);
    r=build(await read(scoped,'test',db.pool),scoped);expect(r.scope.orders).toBe(0);expect(r.scope.deliveries).toBe(1);
    const delivered=build(await read(scoped,'test',db.pool),{...scoped,metric:'deliveries'});expect(delivered.series.find(d=>d.from==='2026-09-08')?.current).toBe(1);
  });
});
