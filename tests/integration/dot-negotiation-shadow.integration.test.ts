import Fastify, { type FastifyInstance } from 'fastify';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

const origin = 'https://farejador.example';
const eventName = 'farejador.conversa.atualizada';
const register = 'registrar_negociacao_sombra';
const list = 'consultar_negociacoes_sombra';
const context = 'consultar_contexto_negociacao_sombra';
const pilot = randomUUID(), livePilot = randomUUID(), erasurePilot = randomUUID(), physicalPilot = randomUUID(),
  outsideAccount = randomUUID(), outsidePilot = randomUUID();
let db: IntegrationDb, app: FastifyInstance, owner: Awaited<ReturnType<typeof createOwner>>;
let sequence = 91000;

async function createOwner() {
  const person = (await db.pool.query(`INSERT INTO network.partner_people(environment,username,password_hash)
    VALUES('test',$1,'fixture') RETURNING id`, ['qa-'+randomUUID()])).rows[0].id as string;
  const collaborator = (await db.pool.query(`INSERT INTO network.matriz_collaborators
    (environment,person_id,display_name,job,panel_role,job_title,work_area)
    VALUES('test',$1,'Dono fictício','colaborador','owner','Dono','administrative') RETURNING id`, [person])).rows[0].id;
  const grant = (await db.pool.query(`INSERT INTO network.dot_oauth_grants(environment,person_id,collaborator_id,
    client_id,resource,scope,code_hash,code_challenge,redirect_uri,code_used_at)
    VALUES('test',$1,$2,'farejador-dot',$3,'farejador.read',$4,$5,'https://chatgpt.com/connector_platform_oauth_redirect',now())
    RETURNING id`, [person,collaborator,origin+'/admin/dot/mcp',randomBytes(32).toString('hex'),'a'.repeat(43)])).rows[0].id;
  const token = 'da_'+randomBytes(32).toString('hex');
  await db.pool.query(`INSERT INTO network.dot_oauth_tokens(environment,grant_id,access_hash,refresh_hash)
    VALUES('test',$1,$2,$3)`, [grant,createHash('sha256').update(token).digest('hex'),randomBytes(32).toString('hex')]);
  const { subscribe } = await import('../../src/admin/dot/events/subscriptions.js');
  await subscribe({person_id:person,collaborator_id:collaborator,grant_id:grant}, {
    name:eventName,arguments:{},cursor:null,delivery:{mode:'webhook',url:'https://receiver.example/events',
      secret:'whsec_'+randomBytes(32).toString('base64')},
  }, db.pool, async (_url,body)=>({status:200,body:JSON.stringify({challenge:JSON.parse(body).challenge})}));
  const sub = (await db.pool.query('SELECT id,activation_id FROM network.dot_event_subscriptions WHERE grant_id=$1',[grant])).rows[0];
  return {person,token,sub};
}

beforeAll(async () => {
  Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:'postgres://test',DATABASE_SSL:'false',
    CHATWOOT_HMAC_SECRET:'fixture',CHATWOOT_ACCOUNT_ID:'1',ADMIN_AUTH_TOKEN:'fixture',DOT_MCP_ENABLED:'true',
    DOT_MCP_PUBLIC_ORIGIN:origin,DOT_EVENTS_ENABLED:'true',DOT_EVENTS_ENCRYPTION_KEY:randomBytes(32).toString('base64'),
    DOT_EVENTS_QUIET_START_HOUR:'0',DOT_EVENTS_QUIET_END_HOUR:'0',DOT_EVENTS_MAX_PER_HOUR:'30',
    DOT_NEGOTIATION_SHADOW_CONVERSATIONS:[pilot,livePilot,erasurePilot,physicalPilot,outsideAccount].join(',')});
  db = await startPostgres(); process.env.DATABASE_URL=db.connectionString; vi.resetModules();
  await (await import('../../src/admin/dot/events/worker.js')).initializeDotEvents(db.pool);
  owner = await createOwner();
  for (const [id,account] of [[pilot,1],[livePilot,1],[erasurePilot,1],[physicalPilot,1],[outsideAccount,2],[outsidePilot,1]] as const) {
    const n=++sequence;
    const contact=(await db.pool.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name)
      VALUES('test',$1,'Contato fictício') RETURNING id`,[n])).rows[0].id;
    await db.pool.query(`INSERT INTO core.conversations(id,environment,chatwoot_account_id,chatwoot_conversation_id,
      contact_id,channel_type,current_status,started_at,last_activity_at)
      VALUES($1,'test',$2,$3,$4,'whatsapp','open',now(),now())`,[id,account,n,contact]);
  }
  app=Fastify(); await (await import('../../src/admin/dot/route.js')).registerDotRoutes(app); await app.ready();
},240000);

afterAll(async () => {
  if (app) await app.close();
  if (db) { await (await import('../../src/persistence/db.js')).pool.end(); await stopPostgres(db); }
});

async function call(name: string, args: object, token=owner.token) {
  const response=await app.inject({method:'POST',url:'/admin/dot/mcp',
    headers:{host:'farejador.example',authorization:'Bearer '+token,'content-type':'application/json',
      accept:'application/json, text/event-stream','mcp-protocol-version':'2026-07-28','mcp-method':'tools/call','mcp-name':name},
    payload:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args,_meta:{
      'io.modelcontextprotocol/protocolVersion':'2026-07-28',
      'io.modelcontextprotocol/clientInfo':{name:'qa',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}}}});
  expect(response.statusCode).toBe(200);
  return response.json();
}

function content(response: {result?: {structuredContent: Record<string, any>}; error?: unknown}) {
  expect(response.error).toBeUndefined();
  return response.result!.structuredContent;
}

async function message(conversation: string, type: 0|1, text: string) {
  const n=++sequence;
  const result=await db.pool.query(`INSERT INTO core.messages(environment,conversation_id,chatwoot_conversation_id,
    chatwoot_message_id,sender_type,message_type,content,sent_at,last_event_at)
    SELECT 'test',id,chatwoot_conversation_id,$2,$3,$4,$5,now(),now() FROM core.conversations WHERE id=$1 RETURNING id`,
  [conversation,n,type===0?'contact':'agent_bot',type,text]);
  return {id:result.rows[0].id as string,n};
}

async function confirmedTurn(conversation: string, question: string, answer: string) {
  const incoming=await message(conversation,0,question), outgoing=await message(conversation,1,answer);
  const row=(await db.pool.query(`INSERT INTO agent.turns(environment,conversation_id,trigger_message_id,agent_version,
    context_hash,status,say_text,delivered_message_id,chatwoot_message_id)
    VALUES('test',$1,$2,'v2','fixture','delivered',$3,$4,$5) RETURNING id`,
  [conversation,incoming.id,answer,outgoing.id,outgoing.n])).rows[0];
  return {id:row.id as string,incoming,outgoing};
}

// Simula um aviso já entregue pelo monitor à conexão OAuth. Nenhum callback externo é disparado.
async function sentEvent(conversation: string, lastMessage: string, pilotMarker: boolean | null = true) {
  const fingerprint=randomBytes(32).toString('hex'), id='evt_'+fingerprint;
  const payload={eventId:id,name:eventName,data:{entity_id:conversation,last_message_id:lastMessage,
    ...(pilotMarker === null ? {} : {sombra_negociacao:pilotMarker})}};
  await db.pool.query(`INSERT INTO ops.dot_event_deliveries(id,environment,subscription_id,activation_id,kind,entity_id,
    fingerprint,payload,status,sent_at) VALUES($1,'test',$2,$3,'conversation',$4,$5,$6,'sent',now())`,
  [id,owner.sub.id,owner.sub.activation_id,conversation,fingerprint,payload]);
  return id;
}

async function commercialCounts() {
  return (await db.pool.query(`SELECT
    (SELECT count(*)::int FROM commerce.orders) AS pedidos,
    (SELECT count(*)::int FROM commerce.partner_orders) AS pedidos_parceiro,
    (SELECT count(*)::int FROM commerce.wholesale_stock_movements) AS movimentos,
    (SELECT count(*)::int FROM ops.outbound_messages) AS envios,
    (SELECT count(*)::int FROM core.messages) AS mensagens`)).rows[0];
}

it('leva um evento autêntico do monitor ao MCP e oculta a resposta real até gravar o parecer', async () => {
  const {collectEvents}=await import('../../src/admin/dot/events/queue.js');
  const {deliverEvents}=await import('../../src/admin/dot/events/delivery.js');
  const {readSnapshot}=await import('../../src/admin/dot/events/snapshots.js');
  const hidden=await message(livePilot,1,'NOTA INTERNA EXCLUIR');
  const removed=await message(livePilot,0,'TEXTO APAGADO EXCLUIR');
  await db.pool.query('UPDATE core.messages SET is_private=true WHERE id=$1',[hidden.id]);
  await db.pool.query('UPDATE core.messages SET deleted_at=now() WHERE id=$1',[removed.id]);
  const turn=await confirmedTurn(livePilot,'Consegue melhorar o valor? Meu e-mail é fixture@example.invalid.',
    'RESPOSTA ORIGINAL SECRETA');
  const tie=(await db.pool.query('SELECT sent_at FROM core.messages WHERE id=$1',[turn.incoming.id])).rows[0].sent_at;
  await db.pool.query('UPDATE core.messages SET sent_at=$1 WHERE id=ANY($2::uuid[])',[tie,[turn.incoming.id,turn.outgoing.id]]);
  const clock=new Date(Date.now()+1000);
  expect((await readSnapshot('conversation',livePilot,db.pool,clock))?.data).toMatchObject({
    entity_id:livePilot,sombra_negociacao:true,last_message_id:turn.outgoing.id});
  await db.pool.query("UPDATE ops.dot_monitor_targets SET due_at=now()-interval '1 second' WHERE environment='test' AND entity_id=$1",[livePilot]);
  await collectEvents(db.pool,clock);
  const queued=await db.pool.query('SELECT status FROM ops.dot_event_deliveries WHERE entity_id=$1',[livePilot]);
  expect(queued.rows).toEqual([{status:'pending'}]);
  const received: {eventId:string;data:{entity_id:string;sombra_negociacao?:boolean}}[]=[];
  await deliverEvents(db.pool,async (_url,body)=>{received.push(JSON.parse(body)); return {status:200,body:''};},clock);
  const event=received.find(row=>row.data.entity_id===livePilot);
  expect(event?.data.sombra_negociacao).toBe(true);
  const later=await message(livePilot,0,'MENSAGEM POSTERIOR EXCLUIR');
  await db.pool.query('UPDATE core.messages SET sent_at=$1 WHERE id=$2',[tie,later.id]);
  const before=await commercialCounts();
  const visible=content(await call(context,{evento:event!.eventId}));
  expect(visible).toMatchObject({turno:turn.id,conversa:livePilot});
  const serialized=JSON.stringify(visible);
  expect(serialized).toContain('Consegue melhorar o valor?');
  for (const secret of ['RESPOSTA ORIGINAL','MENSAGEM POSTERIOR','NOTA INTERNA','TEXTO APAGADO','fixture@example.invalid']) {
    expect(serialized).not.toContain(secret);
  }
  expect(content(await call(register,{evento:event!.eventId,turno:turn.id,decisao:'contrapropor',
    total_centavos:40000,modalidade:'retirada',justificativa:'Manter a condição de retirada.'})).criada).toBe(true);
  const saved=content(await call(list,{})).pareceres.find((row:{turno:string})=>row.turno===turn.id);
  const audit=content(await call('consultar_registros_matriz',{fonte:'core.messages',campos:['content'],
    filtros:[{campo:'id',valor:saved.resposta_mensagem_id}]}));
  expect(audit.registros).toEqual([{content:'RESPOSTA ORIGINAL SECRETA'}]);
  expect(await commercialCounts()).toEqual(before);
});

it('conserva o primeiro parecer do turno mesmo com retry, novo evento e parecer atrasado', async () => {
  const first=await confirmedTurn(pilot,'Se baixar o valor eu levo.','O total para retirada é R$ 400.');
  const oldEvent=await sentEvent(pilot,first.incoming.id);
  const second=await confirmedTurn(pilot,'E se a rota de hoje foi cancelada?','Vou verificar se há outra rota.');
  const routeEvent=await sentEvent(pilot,second.outgoing.id);
  const retryEvent=await sentEvent(pilot,first.outgoing.id);
  const before=await commercialCounts();
  const route={evento:routeEvent,turno:second.id,decisao:'aguardar_dado',justificativa:'Rota cancelada. Falta confirmar nova cobertura.'};
  expect((await call(register,{...route,total_centavos:39000,modalidade:'entrega'})).error).toBeTruthy();
  expect(content(await call(register,route)).criada).toBe(true);
  const late={evento:oldEvent,turno:first.id,decisao:'aceitar',total_centavos:39000,modalidade:'retirada',
    justificativa:'Concessão sugerida para comparação com a oferta de tabela.'};
  expect((await call(register,{...late,evento:routeEvent})).error).toBeTruthy();
  const registrations=await Promise.all([call(register,late),call(register,late)]);
  const saved=registrations.map(content);
  expect(saved.map(r=>r.criada).sort()).toEqual([false,true]); expect(saved[0].id).toBe(saved[1].id);
  expect(content(await call(register,{...late,evento:retryEvent,total_centavos:37000})))
    .toMatchObject({id:saved[0].id,turno:first.id,criada:false});
  const results=content(await call(list,{})).pareceres;
  const proposed=results.find((row:{turno:string})=>row.turno===first.id);
  expect(proposed).toMatchObject({evento:oldEvent,decisao:'aceitar',total_centavos:39000,modalidade:'retirada'});
  const actual=content(await call('consultar_registros_matriz',{fonte:'core.messages',campos:['content'],
    filtros:[{campo:'id',valor:proposed.resposta_mensagem_id}]}));
  expect(actual.registros).toEqual([{content:'O total para retirada é R$ 400.'}]);
  expect(results.find((row:{turno:string})=>row.turno===second.id)).toMatchObject({
    evento:routeEvent,decisao:'aguardar_dado',total_centavos:null,modalidade:null});
  expect(await commercialCounts()).toEqual(before);
});

it('rejeita outra conta, conversa fora do piloto e outra identidade', async () => {
  for (const conversation of [outsideAccount,outsidePilot]) {
    const turn=await confirmedTurn(conversation,'Quanto custa?','O preço continua o da tabela.');
    const event=await sentEvent(conversation,turn.incoming.id);
    expect((await call(register,{evento:event,turno:turn.id,decisao:'manter',justificativa:'Manter tabela.'})).error).toBeTruthy();
  }
  const turn=await confirmedTurn(pilot,'Dá para retirar?','Tem retirada na loja.');
  const event=await sentEvent(pilot,turn.outgoing.id), other=await createOwner();
  for (const marker of [false,null]) {
    const ordinaryEvent=await sentEvent(pilot,turn.outgoing.id,marker);
    expect((await call(register,{evento:ordinaryEvent,turno:turn.id,decisao:'manter',justificativa:'Manter tabela.'})).error).toBeTruthy();
  }
  expect((await call(register,{evento:event,turno:turn.id,decisao:'manter',justificativa:'Manter tabela.'},other.token)).error).toBeTruthy();
  expect(content(await call(list,{},other.token)).pareceres).toEqual([]);
});

it('preserva a integridade e acompanha a remoção da origem sem bloquear a retenção do monitor', async () => {
  const turn=await confirmedTurn(pilot,'Quero comparar.','O preço para retirada é o da tabela.');
  const event=await sentEvent(pilot,turn.incoming.id);
  const response=await call(register,{evento:event,turno:turn.id,decisao:'manter',justificativa:'Tabela atual.'});
  const id=content(response).id;
  await expect(db.pool.query('UPDATE ops.dot_negotiation_shadow SET rationale=$2 WHERE id=$1',[id,'Outro motivo']))
    .rejects.toMatchObject({code:'55000'});
  await expect(db.pool.query('DELETE FROM ops.dot_negotiation_shadow WHERE id=$1',[id])).rejects.toMatchObject({code:'55000'});
  expect((await db.pool.query(`SELECT relrowsecurity FROM pg_class WHERE oid='ops.dot_negotiation_shadow'::regclass`)).rows[0].relrowsecurity).toBe(true);
  expect((await db.pool.query(`SELECT has_table_privilege('farejador_partner_app','ops.dot_negotiation_shadow','SELECT') access`)).rows[0].access).toBe(false);
  await db.pool.query('DELETE FROM ops.dot_event_deliveries WHERE id=$1',[event]);
  expect((await db.pool.query('SELECT id FROM ops.dot_negotiation_shadow WHERE id=$1',[id])).rows).toEqual([]);
});

it('apaga justificativas na anonimização do contato e na remoção física do titular', async () => {
  for (const [conversation,soft] of [[erasurePilot,true],[physicalPilot,false]] as const) {
    const turn=await confirmedTurn(conversation,'Estou pesquisando.','Tem retirada na loja.');
    const event=await sentEvent(conversation,turn.incoming.id);
    const {id}=content(await call(register,{evento:event,turno:turn.id,decisao:'manter',justificativa:'Tabela atual.'}));
    const {contact_id}= (await db.pool.query('SELECT contact_id FROM ops.dot_negotiation_shadow WHERE id=$1',[id])).rows[0];
    if (soft) await db.pool.query(`SELECT ops.anonymize_contact($1,'fixture','fixture','pedido do titular')`, [contact_id]);
    else await db.pool.query('DELETE FROM core.contacts WHERE id=$1',[contact_id]);
    expect((await db.pool.query('SELECT id FROM ops.dot_negotiation_shadow WHERE id=$1',[id])).rows).toEqual([]);
    expect((await db.pool.query('SELECT id FROM agent.turns WHERE id=$1',[turn.id])).rowCount).toBe(1);
  }
});
