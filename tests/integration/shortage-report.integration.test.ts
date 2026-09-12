import { beforeAll,afterAll,describe,it,expect,vi } from 'vitest';
import { startPostgres,stopPostgres,type IntegrationDb } from './helpers/postgres.js';
import { createPartnerFixture } from './helpers/partner-fixtures.js';
let db:IntegrationDb,conversation:string,product:string,partner:Awaited<ReturnType<typeof createPartnerFixture>>;
let read:typeof import('../../src/admin/painel/shortage-report-data.js').readShortageSnapshot;
let build:typeof import('../../src/admin/painel/queries-shortage-report.js').buildShortageReport;
const filter={from:'2026-09-01',to:'2026-09-10',mode:'month' as const,store:'',measure:'',search:'',view:'overview' as const};
beforeAll(async()=>{
  db=await startPostgres();vi.stubEnv('DATABASE_URL',db.connectionString);vi.stubEnv('FAREJADOR_ENV','test');vi.stubEnv('CHATWOOT_HMAC_SECRET','test');vi.stubEnv('ADMIN_AUTH_TOKEN','test');
  read=(await import('../../src/admin/painel/shortage-report-data.js')).readShortageSnapshot;build=(await import('../../src/admin/painel/queries-shortage-report.js')).buildShortageReport;
  partner=await createPartnerFixture(db.pool,{initialStockQty:6});
  await db.pool.query(`UPDATE commerce.partner_stock_levels SET tire_size='90/90-12',tire_condition='novo',quantity_reserved=2 WHERE id=$1`,[partner.stockId]);
  product=(await db.pool.query(`INSERT INTO commerce.products(environment,product_code,product_name,product_type,brand,tire_condition)
    VALUES('test','SHORTAGE-REPORT','Pneu de prova','tire','Michelin','novo') RETURNING id`)).rows[0].id;
  await db.pool.query(`INSERT INTO commerce.tire_specs(environment,product_id,tire_size,position) VALUES('test',$1,'90/90-12','front')`,[product]);
  await db.pool.query(`INSERT INTO commerce.matriz_product_prices(environment,product_id,price_amount) VALUES('test',$1,200)`,[product]);
  await db.pool.query(`INSERT INTO commerce.product_prices(environment,product_id,price_type,price_amount,currency,valid_from,valid_until)
    VALUES('test',$1,'regular',180,'BRL',now()-interval '1 day',now()+interval '1 day'),('test',$1,'regular',1,'BRL',now()+interval '1 day',NULL)`,[product]);
  await db.pool.query(`INSERT INTO commerce.wholesale_stock(environment,measure,brand,tire_condition,quantity_on_hand,quantity_reserved,unit_cost)
    VALUES('test','90/90-12','Michelin','novo',10,3,80)`);
  const contact=(await db.pool.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id) VALUES('test',9786501) RETURNING id`)).rows[0].id;
  conversation=(await db.pool.query(`INSERT INTO core.conversations(environment,chatwoot_conversation_id,chatwoot_account_id,contact_id,current_status,started_at,last_activity_at)
    VALUES('test',9786501,1,$1,'open',now(),now()) RETURNING id`,[contact])).rows[0].id;
  const stores=[{id:partner.unitId,name:'Parceiro Alcântara',available:false},{id:'matriz',name:'Matriz',available:false}];
  for(const [key,measure,at] of [['first','90/90-12','2026-09-01T03:00:00Z'],['repeat','90/90-12','2026-09-10T20:00:00Z'],['no-price','180/55-17','2026-09-10T20:01:00Z'],['outside','90/90-12','2026-09-11T03:00:00Z']])
    await db.pool.query(`INSERT INTO ops.bot_stock_searches(environment,conversation_id,search_key,tool_name,occurred_at,measure,filters,stores)
      VALUES('test',$1,$2,'buscar_produto',$3,$4,'{"marca":"Michelin","condicao_pneu":"novo"}',$5::jsonb)`,[conversation,key,at,measure,JSON.stringify(stores)]);
},120000);
afterAll(async()=>{if(db){const {pool}=await import('../../src/persistence/db.js');await pool.end();await stopPostgres(db);}vi.unstubAllEnvs();});
describe('relatório central de faltas no Postgres real',()=>{
  it('consulta o schema atual, mantém isolamento e considera reservas e preços próprios de cada canal',async()=>{
    const data=await read(filter,'test',db.pool),matrix=build(data,{...filter,store:'matriz'}),store=build(data,{...filter,store:partner.unitId});
    expect(data.traces).toHaveLength(3);expect(matrix.summary).toEqual({consultations:1,shortages:4,stores:2,measures:2});
    expect(matrix.measures.every(m=>m.shortages===1)).toBe(true);
    const {getBotShortages}=await import('../../src/admin/painel/queries-bot-faltas.js');
    const bot=await getBotShortages(filter,'test',db.pool);
    expect(bot).toMatchObject({consultations:matrix.summary.consultations,shortages:matrix.summary.shortages,measure_count:matrix.summary.measures});
    expect(matrix.store?.potential).toMatchObject({amount:200,opportunities:2,priced:1,unpriced:1,repeated:1});
    expect(store.store?.potential.amount).toBe(180);expect(store.measures.find(m=>m.measure==='90/90-12')?.stock).toBe(4);
    expect(matrix.measures.find(m=>m.measure==='90/90-12')?.stock).toBe(7);
    expect((await read(filter,'prod',db.pool)).traces).toEqual([]);
    expect(store.consultations[0]?.stores).toHaveLength(2);expect(JSON.stringify(store)).not.toContain(conversation);
  });
  it('atualiza a referência atual sem reescrever a busca e mantém ausência de preço explícita',async()=>{
    const before=(await db.pool.query(`SELECT id,stores,filters FROM ops.bot_stock_searches WHERE environment='test' ORDER BY id`)).rows;
    await db.pool.query(`UPDATE commerce.matriz_product_prices SET valid_until=now() WHERE environment='test' AND product_id=$1 AND valid_until IS NULL`,[product]);
    const data=await read(filter,'test',db.pool),r=build(data,{...filter,store:'matriz'});
    expect(r.store?.potential.amount).toBeNull();expect(r.store?.potential.unpriced).toBe(2);
    expect((await db.pool.query(`SELECT id,stores,filters FROM ops.bot_stock_searches WHERE environment='test' ORDER BY id`)).rows).toEqual(before);
    await expect(db.pool.query(`UPDATE ops.bot_stock_searches SET measure='wrong' WHERE environment='test'`)).rejects.toThrow();
  });
});
