import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startPostgres, stopPostgres, applyMigrationFile, type IntegrationDb } from './helpers/postgres.js';
import { createPartnerFixture } from './helpers/partner-fixtures.js';

let db: IntegrationDb, serial = 983500;
let getBot: typeof import('../../src/admin/painel/queries-bot-visao.js').getBotVisao;
let getClients: typeof import('../../src/admin/painel/queries-clientes.js').getClientesPainel;
const migration = '0235_order_cancellation_analytics.sql';

async function conversation(environment = 'test', city = 'Duque de Caxias') {
  const cw = ++serial;
  const contact = (await db.pool.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name)
    VALUES($1,$2,'Teste cancelamento') RETURNING id`,[environment,cw])).rows[0].id;
  const id = (await db.pool.query(`INSERT INTO core.conversations(environment,chatwoot_conversation_id,
    chatwoot_account_id,contact_id,current_status,started_at,last_activity_at)
    VALUES($1,$2,1,$3,'open',now(),now()) RETURNING id`,[environment,cw,contact])).rows[0].id;
  const message = (await db.pool.query(`INSERT INTO core.messages(environment,chatwoot_message_id,conversation_id,
    chatwoot_conversation_id,sender_type,message_type,content,is_private,sent_at)
    VALUES($1,$2,$3,$2,'contact',0,'Consulta de dois pneus',false,now()) RETURNING id`,[environment,cw,id])).rows[0].id;
  await db.pool.query(`INSERT INTO agent.turns(environment,conversation_id,trigger_message_id,agent_version,context_hash,status,actions)
    VALUES($1,$2,$3::uuid,'v2',$3::text,'delivered','[]')`,[environment,id,message]);
  for (const [key,value] of [['municipio_entrega',city],['medida_consultada','175/65-14'],
    ['medida_consultada','90/90-12'],['preco_cotado',89],['pedido_criado',true]]) {
    await db.pool.query(`INSERT INTO analytics.conversation_facts(environment,conversation_id,fact_key,fact_value,
      observed_at,truth_type,source,extractor_version) VALUES($1,$2,$3,$4,now(),'observed','test',$5)`,
    [environment,id,key,JSON.stringify(value),randomUUID()]);
  }
  return {id,contact,environment,city};
}
type Conversation = Awaited<ReturnType<typeof conversation>>;
async function order(c: Conversation, status = 'confirmed', partner: string | null = null) {
  return (await db.pool.query(`INSERT INTO commerce.orders(environment,contact_id,source_conversation_id,
    total_amount,status,fulfillment_mode,partner_order_id) VALUES($1,$2,$3,178,$4,'pickup',$5) RETURNING id`,
  [c.environment,c.contact,c.id,status,partner])).rows[0].id as string;
}
async function classifications(c: Conversation) {
  return Object.fromEntries((await db.pool.query(`SELECT dimension,value FROM analytics.current_classifications
    WHERE environment=$1 AND conversation_id=$2`,[c.environment,c.id])).rows.map(r=>[r.dimension,r.value]));
}
async function history(c: Conversation) {
  return (await db.pool.query(`SELECT * FROM analytics.conversation_classifications WHERE environment=$1
    AND conversation_id=$2 ORDER BY id`,[c.environment,c.id])).rows;
}
async function facts(c: Conversation) {
  return (await db.pool.query(`SELECT * FROM analytics.conversation_facts WHERE environment=$1
    AND conversation_id=$2 ORDER BY id`,[c.environment,c.id])).rows;
}
let old: Conversation, before: Awaited<ReturnType<typeof history>>, oldFacts: Awaited<ReturnType<typeof facts>>;
beforeAll(async () => {
  db=await startPostgres({throughMigration:'0234_vehicle_type_operation_snapshots.sql'});
  Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:db.connectionString,
    CHATWOOT_HMAC_SECRET:'test',ADMIN_AUTH_TOKEN:'test'});
  vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('Rede externa proibida');}));
  old=await conversation(); await order(old,'cancelled');
  await db.pool.query('SELECT analytics.extract_classifications_for_conv($1)',[old.id]);
  expect((await classifications(old)).final_outcome).toBe('fechou');
  before=await history(old); oldFacts=await facts(old);
  await applyMigrationFile(db.pool,migration);
  getBot=(await import('../../src/admin/painel/queries-bot-visao.js')).getBotVisao;
  getClients=(await import('../../src/admin/painel/queries-clientes.js')).getClientesPainel;
},180000);
afterAll(async()=>{vi.unstubAllGlobals();if(db)await stopPostgres(db);});

describe('cancelamento em demanda, classificação e Kanban',()=>{
  it('corrige o passado preservando fatos e revisões, sem duplicar no replay',async()=>{
    expect(await classifications(old)).toMatchObject({final_outcome:'cancelado',buyer_intent:'cancelou_pedido',
      stage_reached:'pedido_criado',loss_reason:'pedido_cancelado'});
    const after=await history(old);
    for(const previous of before) {
      const saved=after.find(r=>r.id===previous.id);
      expect(saved.superseded_by).toBeTruthy();
      expect({...saved,superseded_by:undefined,revision:undefined})
        .toEqual({...previous,superseded_by:undefined,revision:undefined});
    }
    expect(await facts(old)).toEqual(oldFacts);
    await applyMigrationFile(db.pool,migration);
    await db.pool.query('SELECT analytics.extract_classifications_for_conv($1)',[old.id]);
    expect(await history(old)).toEqual(after);
    const bot=await getBot('today','test',db.pool);
    expect(bot.mapa.find(r=>r.municipio===old.city)).toMatchObject({chamou:1,pediu:0,efetivou:0});
    expect(bot.medidas_por_municipio?.filter(r=>r.municipio===old.city).map(r=>r.medida).sort())
      .toEqual(['175/65-14','90/90-12']);
    expect(bot.funil.find(r=>r.etapa==='pedido_criado')?.n).toBe(1);
    expect(bot.perdas.find(r=>r.motivo==='pedido_cancelado')?.n).toBe(1);
    const lead=(await getClients('test',db.pool)).rows.find(r=>r.lead_conversation_id===old.id);
    expect(lead).toMatchObject({lead_lane:'perdido',lead_waiting_on:'nenhum',lead_outcome:'cancelado',purchases:0,total_spent:0});
  });

  it('atualiza imediatamente ao cancelar sem nova mensagem, e volta a converter em novo pedido',async()=>{
    const c=await conversation('test','Niterói'), id=await order(c);
    expect((await classifications(c)).buyer_intent).toBe('comprou');
    const savedFacts=await facts(c);
    await db.pool.query("UPDATE commerce.orders SET status='cancelled' WHERE id=$1",[id]);
    expect((await classifications(c)).final_outcome).toBe('cancelado');
    let lead=(await getClients('test',db.pool)).rows.find(r=>r.lead_conversation_id===c.id);
    expect(lead).toMatchObject({lead_lane:'perdido',lead_waiting_on:'nenhum',purchases:0});
    expect((await getBot('today','test',db.pool)).mapa.find(r=>r.municipio===c.city)?.pediu).toBe(0);
    await order(c);
    expect(await classifications(c)).toMatchObject({final_outcome:'fechou',buyer_intent:'comprou'});
    expect((await classifications(c)).loss_reason).toBeUndefined();
    lead=(await getClients('test',db.pool)).rows.find(r=>r.lead_conversation_id===c.id);
    expect(lead).toMatchObject({lead_lane:'convertido',purchases:1,total_spent:178});
    expect((await getBot('today','test',db.pool)).mapa.find(r=>r.municipio===c.city)?.pediu).toBe(1);
    expect(await facts(c)).toEqual(savedFacts);
  });

  it('cancelar só um dos dois pedidos mantém o outro válido, sem misturar ambientes',async()=>{
    const c=await conversation('test','Maricá'), prod=await conversation('prod','Maricá');
    const a=await order(c); await order(c); const other=await order(prod);
    const prodBefore=await history(prod);
    await db.pool.query("UPDATE commerce.orders SET status='cancelled' WHERE id=$1",[a]);
    expect((await classifications(c)).final_outcome).toBe('fechou');
    expect((await getBot('today','test',db.pool)).mapa.find(r=>r.municipio===c.city)).toMatchObject({chamou:1,pediu:1});
    expect(await history(prod)).toEqual(prodBefore);
    await db.pool.query("UPDATE commerce.orders SET status='cancelled' WHERE id=$1",[other]);
    expect((await getBot('today','prod',db.pool)).mapa.find(r=>r.municipio===prod.city)?.pediu).toBe(0);
    expect((await classifications(c)).final_outcome).toBe('fechou');
  });

  it('reflete cancelamento na loja parceira mesmo antes de atualizar o espelho',async()=>{
    const c=await conversation('test','Rio de Janeiro'), partner=await createPartnerFixture(db.pool);
    const po=(await db.pool.query(`INSERT INTO commerce.partner_orders(environment,unit_id,total_amount,status,fulfillment_mode)
      VALUES('test',$1,178,'confirmed','pickup') RETURNING id`,[partner.unitId])).rows[0].id;
    await order(c,'confirmed',po);
    await db.pool.query("UPDATE commerce.partner_orders SET status='cancelled' WHERE id=$1",[po]);
    expect((await classifications(c)).final_outcome).toBe('cancelado');
    expect((await getBot('today','test',db.pool)).mapa.find(r=>r.municipio===c.city)?.pediu).toBe(0);
    expect((await getClients('test',db.pool)).rows.find(r=>r.lead_conversation_id===c.id))
      .toMatchObject({lead_lane:'perdido',lead_waiting_on:'nenhum'});
  });
});
