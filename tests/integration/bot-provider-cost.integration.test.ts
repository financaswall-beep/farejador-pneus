import { randomUUID } from 'node:crypto';
import { afterAll,beforeAll,beforeEach,expect,it,vi } from 'vitest';
import { startPostgres,stopPostgres,type IntegrationDb,buildRestrictedConnectionString } from './helpers/postgres.js';
import { Client } from 'pg';
let db:IntegrationDb,conversation:string,job:{jobId:string;conversationId:string;triggerMessageId:string;environment:string};
let record:typeof import('../../src/atendente-v2/model-usage.js').recordBotModelUsage;
let overview:typeof import('../../src/admin/painel/matriz-overview-sales.js').readOverviewBotCost;
let botVisao:typeof import('../../src/admin/painel/queries-bot-visao.js').getBotVisao;
const body=(id=randomUUID())=>({id,model:'gpt-5.6-sol',service_tier:'default',status:'completed',
  usage:{input_tokens:10_000,output_tokens:1_000,input_tokens_details:{cached_tokens:6_000,cache_write_tokens:2_000}},
  output:[{text:'Conteúdo privado que NÃO deve ser persistido na medição'}]});
const all=()=>overview(db.pool,'test','2000-01-01','2100-01-01');
async function write(response:unknown,environment='test',failure?:string){
  const client=await db.pool.connect();try{await record(client,{...job,environment},{id:randomUUID(),response,failure});}finally{client.release();}
}
beforeAll(async()=>{
  Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:'postgres://test',
    CHATWOOT_HMAC_SECRET:'test',ADMIN_AUTH_TOKEN:'test',OPENAI_MODEL:'gpt-5.6-sol',OPENAI_USD_BRL:'5.5'});
  vi.resetModules();db=await startPostgres();
  ({recordBotModelUsage:record}=await import('../../src/atendente-v2/model-usage.js'));
  ({readOverviewBotCost:overview}=await import('../../src/admin/painel/matriz-overview-sales.js'));
  ({getBotVisao:botVisao}=await import('../../src/admin/painel/queries-bot-visao.js'));
  const contact=(await db.pool.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name)
    VALUES('test',99178,'Custo teste') RETURNING id`)).rows[0].id;
  conversation=(await db.pool.query(`INSERT INTO core.conversations(environment,chatwoot_account_id,
    chatwoot_conversation_id,contact_id,current_status,started_at,last_activity_at)
    VALUES('test',2,99178,$1,'open',now()-interval '90 days',now()) RETURNING id`,[contact])).rows[0].id;
},180_000);
beforeEach(async()=>{
  await db.pool.query('DELETE FROM agent.turns; TRUNCATE ops.bot_model_usage');
  job={jobId:randomUUID(),conversationId:conversation,triggerMessageId:randomUUID(),environment:'test'};
});
afterAll(async()=>{if(db)await stopPostgres(db);});

it('calcula preços do Sol e câmbio, deduplica resposta, não persiste conteúdo e mantém cards consistentes',async()=>{
  const raw=body();await write(raw);await write(raw);
  const rows=(await db.pool.query('SELECT * FROM ops.bot_model_usage')).rows;
  expect(rows).toHaveLength(1);expect(rows[0].estimated_usd).toBe('0.0404000000');
  expect(JSON.stringify(rows)).not.toContain('Conteúdo privado');
  expect(await all()).toMatchObject({estimated_cents:22,estimated_usd:0.0404,calls:1,missing_usage:0,
    tokens:11_000,cached_tokens:6_000,cache_write_tokens:2_000,usd_brl_min:5.5,usd_brl_max:5.5});
  const cards=(await botVisao('today','test',db.pool)).cards!;
  expect(Number(cards.custo_bot)).toBeCloseTo(0.2222,6);
  expect(Number(cards.custo_bot_usd)).toBeCloseTo(0.0404,6);
  expect(cards.conversas).toBe(0); // Conversa antiga, custo de hoje.
  expect(Number(cards.faturamento)).toBe(0);
});
it('conta todas as rodadas e respostas incompletas, inclusive sem agent.turns enviado',async()=>{
  await write(body());await write({...body(),status:'incomplete'});
  expect(await all()).toMatchObject({estimated_cents:44,calls:2,tokens:22_000,missing_usage:0});
  expect(Number((await db.pool.query('SELECT count(*) FROM agent.turns')).rows[0].count)).toBe(0);
});
it('consumo desconhecido não vira zero nem esconde o subtotal conhecido',async()=>{
  await write(body());await write(undefined,'test','timeout_unknown_usage');
  expect(await all()).toMatchObject({estimated_cents:null,estimated_usd:null,known_estimated_cents:22,calls:2,missing_usage:1});
  const cards=(await botVisao('today','test',db.pool)).cards!;
  expect(cards.custo_bot).toBeNull();expect(cards.custo_bot_pendente).toBe(1);
  expect(Number(cards.custo_bot_parcial)).toBeCloseTo(0.2222,6);
});
it('não aplica Sol a modelo/tier diferente ou cache desconhecido',async()=>{
  await write({...body(),model:'gpt-5.6-terra'});
  await write({...body(),service_tier:'priority'});
  await write({...body(),usage:{input_tokens:10,output_tokens:5}});
  expect(await all()).toMatchObject({estimated_cents:null,calls:3,missing_usage:3});
});
it('não mistura ambientes e ausência real de chamadas resulta em zero',async()=>{
  await write(body(),'prod');expect(await all()).toMatchObject({estimated_cents:0,calls:0,missing_usage:0,tokens:0});
  expect(await overview(db.pool,'prod','2000-01-01','2100-01-01')).toMatchObject({estimated_cents:22,calls:1});
});
it('apuração usa a data civil da chamada e não a data de início da conversa',async()=>{
  await write(body());
  await db.pool.query("UPDATE ops.bot_model_usage SET created_at='2026-09-17T02:59:00Z'");
  expect(await overview(db.pool,'test','2026-09-16','2026-09-16')).toMatchObject({estimated_cents:22});
  expect(await overview(db.pool,'test','2026-09-17','2026-09-17')).toMatchObject({estimated_cents:0});
  const daily=await db.pool.query("SELECT custo_bot_brl FROM analytics.v_daily_metrics WHERE environment='test' AND dia='2026-09-16'");
  expect(Number(daily.rows[0].custo_bot_brl)).toBeCloseTo(0.2222,6);
});
it('histórico sem medição fica pendente e não duplica os tokens de uma chamada registrada',async()=>{
  await db.pool.query(`INSERT INTO agent.turns(environment,conversation_id,trigger_message_id,
    agent_version,context_hash,llm_input_tokens,llm_output_tokens) VALUES('test',$1,$2,'v2','fixture',10000,1000)`,
  [conversation,job.triggerMessageId]);
  expect(await all()).toMatchObject({estimated_cents:null,tokens:11_000,missing_usage:1});
  await write(body());expect(await all()).toMatchObject({estimated_cents:22,tokens:11_000,calls:1,missing_usage:0});
});
it('guarda câmbio de cada chamada sem recalcular o histórico com configuração nova',async()=>{
  await write(body());
  await db.pool.query('UPDATE ops.bot_model_usage SET usd_brl=6');
  await write(body());
  expect(await all()).toMatchObject({estimated_cents:46,usd_brl_min:5.5,usd_brl_max:6});
});
it('o parceiro não tem acesso à medição global',async()=>{
  const client=new Client({connectionString:buildRestrictedConnectionString(db.connectionString)});
  try{await client.connect();await expect(client.query('SELECT * FROM ops.bot_model_usage')).rejects.toMatchObject({code:'42501'});}
  finally{await client.end();}
});
