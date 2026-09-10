import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';
import { createPartnerFixture } from './helpers/partner-fixtures.js';
import { withStockSearchTrace, observeSearchProducts, observeSearchStore } from '../../src/atendente-v2/stock-search-trace.js';
let db:IntegrationDb,conversationId:string,partner:Awaited<ReturnType<typeof createPartnerFixture>>;
let queries:typeof import('../../src/admin/painel/queries-bot-faltas.js');
const period={from:'2026-09-01',to:'2026-09-10'};
beforeAll(async()=>{
  db=await startPostgres();
  vi.stubEnv('DATABASE_URL',db.connectionString);vi.stubEnv('FAREJADOR_ENV','test');
  vi.stubEnv('CHATWOOT_HMAC_SECRET','test-secret');vi.stubEnv('ADMIN_AUTH_TOKEN','test-admin-token');
  vi.stubEnv('WHOLESALE_UNIFIED_STOCK','true');vi.stubEnv('ROUTING_GEO','false');
  queries=await import('../../src/admin/painel/queries-bot-faltas.js');
  const contact=(await db.pool.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id) VALUES ('test',9897654) RETURNING id`)).rows[0].id;
  conversationId=(await db.pool.query(`INSERT INTO core.conversations(environment,chatwoot_conversation_id,chatwoot_account_id,contact_id,current_status,started_at,last_activity_at) VALUES ('test',9897654,1,$1,'open',now(),now()) RETURNING id`,[contact])).rows[0].id;
  partner=await createPartnerFixture(db.pool,{initialStockQty:6});
  await db.pool.query(`UPDATE commerce.partner_stock_levels SET tire_size='90/90-12',tire_condition='novo' WHERE id=$1`,[partner.stockId]);
  const insert=async(key:string,measure:string,stores:unknown[],at='2026-09-10T14:00:00Z')=>db.pool.query(
    `INSERT INTO ops.bot_stock_searches(environment,conversation_id,search_key,tool_name,measure,stores,occurred_at,municipality)
     VALUES('test',$1,$2,'buscar_produto',$3,$4::jsonb,$5,'São Gonçalo')`,[conversationId,key,measure,JSON.stringify(stores),at]);
  const no=(id:string,name:string)=>({id,name,available:false});
  await insert('same-search','90/90-12',[no(partner.unitId,'Parceiro Alcântara'),no('matriz','Matriz')]);
  await insert('same-search','180/55-17',[no('matriz','Matriz')]);
  await insert('other-search','130/70-13',[no('matriz','Matriz'),{id:partner.unitId,name:'Parceiro Alcântara',available:true}]);
  await insert('outside','90/90-12',[no('matriz','Matriz')],'2026-09-11T03:00:00Z');
  await insert('before','90/90-12',[no('matriz','Matriz')],'2026-09-01T02:59:59Z');
},120000);
afterAll(async()=>{vi.unstubAllEnvs();if(db)await stopPostgres(db);});
describe('relatório de faltas real no Postgres',()=>{
  it('conta consultas uma vez, faltas por loja/medida e respeita São Paulo e ambiente',async()=>{
    const report=await queries.getBotShortages(period,'test',db.pool);
    expect(report).toMatchObject({consultations:2,shortages:4,store_count:2,measure_count:3});
    expect((await queries.getBotShortages(period,'prod',db.pool)).shortages).toBe(0);
  });
  it('filtra pela loja sem perder a sequência completa; estoque atual não reescreve a falta',async()=>{
    const filter={...period,store:partner.unitId,measure:'90/90-12'};
    const detail=await queries.getBotShortageConsultations(filter,'test',db.pool);
    expect(detail.total).toBe(1);expect(detail.rows[0].stores).toHaveLength(2);
    expect(detail.rows[0].stores.every((s:{available:boolean})=>!s.available)).toBe(true);
    expect(detail.stock.find(s=>s.store_id===partner.unitId).quantity).toBe(6);
    expect((await queries.getBotShortageConsultations({...filter,measure:'130/70-13'},'test',db.pool)).rows).toEqual([]);
    const exported=await queries.exportBotShortages({...period,store:partner.unitId},'test',db.pool);
    expect(exported).toHaveLength(1);expect(exported[0].measure).toBe('90/90-12');
  });
  it('persiste de forma idempotente e impede alteração do histórico',async()=>{
    const client=await db.pool.connect(),key=randomUUID();
    const run=()=>withStockSearchTrace(client,'test',conversationId,{key,tool:'buscar_produto',args:{}},async()=>{
      observeSearchProducts([{id:'a',measure:'90/90-12',matrixAvailable:0}]);
      observeSearchStore(partner.unitId,'Parceiro Alcântara',new Map());return '{"encontrado":true}';
    });
    try{await run();await run();}finally{client.release();}
    const rows=(await db.pool.query('SELECT id FROM ops.bot_stock_searches WHERE search_key=$1',[key])).rows;
    expect(rows).toHaveLength(1);
    await expect(db.pool.query('UPDATE ops.bot_stock_searches SET measure=$1 WHERE id=$2',['x',rows[0].id])).rejects.toThrow();
    await expect(db.pool.query('DELETE FROM ops.bot_stock_searches WHERE id=$1',[rows[0].id])).rejects.toThrow();
    await expect(db.pool.query(`INSERT INTO ops.bot_stock_searches(environment,conversation_id,search_key,tool_name,measure,stores)
      VALUES('prod',$1,'invalid','buscar_produto','90/90-12','[]')`,[conversationId])).rejects.toThrow('stock_search_environment_mismatch');
    await db.pool.query('SET ROLE farejador_partner_app');
    try {await expect(db.pool.query('SELECT * FROM ops.bot_stock_searches')).rejects.toThrow('permission denied');}
    finally {await db.pool.query('RESET ROLE');}
  });
  it('a ferramenta real mantém exatamente a resposta e registra o estoque observado',async()=>{
    const {executeTool}=await import('../../src/atendente-v2/tools.js');
    const product=(await db.pool.query(`INSERT INTO commerce.products(environment,product_code,product_name,product_type,brand,tire_condition)
      VALUES('test','FALTAS-TRACE','Pneu teste','tire','FaltasTest','novo') RETURNING id`)).rows[0].id;
    await db.pool.query(`INSERT INTO commerce.tire_specs(environment,product_id,tire_size) VALUES('test',$1,'195/55-16')`,[product]);
    await db.pool.query(`INSERT INTO commerce.wholesale_stock(environment,measure,brand,tire_condition,quantity_on_hand,unit_cost)
      VALUES('test','195/55-16','FaltasTest','novo',0,40)`);
    const client=await db.pool.connect(),args={medida_pneu:'195/55-16',marca:'FaltasTest'},key=randomUUID();
    try{
      const original=await executeTool(client,'test',conversationId,'buscar_produto',args);
      const traced=await withStockSearchTrace(client,'test',conversationId,{key,tool:'buscar_produto',args},()=>executeTool(client,'test',conversationId,'buscar_produto',args));
      expect(traced).toBe(original);expect(JSON.parse(traced).produtos[0].total_stock_available).toBe(0);
      const row=(await client.query('SELECT measure,stores FROM ops.bot_stock_searches WHERE search_key=$1',[key])).rows[0];
      expect(row).toEqual({measure:'195/55-16',stores:[{id:'matriz',name:'Matriz',kind:'matrix',available:false}]});
    }finally{client.release();}
  });
});
