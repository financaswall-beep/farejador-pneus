import Fastify,{type FastifyInstance} from 'fastify';
import { createHash,randomBytes,randomUUID } from 'node:crypto';
import { beforeAll,beforeEach,afterAll,expect,it,vi } from 'vitest';
import { startPostgres,stopPostgres,type IntegrationDb } from './helpers/postgres.js';
import type { DotIdentity } from '../../src/admin/dot/token-store.js';
import type { WebhookSender } from '../../src/admin/dot/events/https.js';
let db:IntegrationDb,app:FastifyInstance,identity:DotIdentity,token:string;
let subscriptions:typeof import('../../src/admin/dot/events/subscriptions.js');
let queue:typeof import('../../src/admin/dot/events/queue.js');
let delivery:typeof import('../../src/admin/dot/events/delivery.js');
let snapshots:typeof import('../../src/admin/dot/events/snapshots.js');
const origin='https://farejador.example',secret='whsec_'+Buffer.alloc(32,3).toString('base64');
const event='farejador.conversa.atualizada',url='https://receiver.example/events';
const echo:WebhookSender=async(_url,body)=>({status:200,body:JSON.stringify({challenge:JSON.parse(body).challenge})});
let count=90000;

beforeAll(async()=>{
  Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:'postgres://test',DATABASE_SSL:'false',
    CHATWOOT_HMAC_SECRET:'test-secret',CHATWOOT_ACCOUNT_ID:'1',ADMIN_AUTH_TOKEN:'test',DOT_MCP_ENABLED:'true',
    DOT_MCP_PUBLIC_ORIGIN:origin,DOT_EVENTS_ENABLED:'true',DOT_EVENTS_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64'),
    DOT_EVENTS_QUIET_START_HOUR:'0',DOT_EVENTS_QUIET_END_HOUR:'0',DOT_EVENTS_MAX_PER_HOUR:'30'});
  db=await startPostgres();process.env.DATABASE_URL=db.connectionString;vi.resetModules();
  const person=(await db.pool.query(`INSERT INTO network.partner_people(environment,username,password_hash)
    VALUES('test','dot-monitor-owner','hash-fixture') RETURNING id`)).rows[0].id;
  const collaborator=(await db.pool.query(`INSERT INTO network.matriz_collaborators
    (environment,person_id,display_name,job,panel_role,job_title,work_area)
    VALUES('test',$1,'Dono','colaborador','owner','Dono','administrative') RETURNING id`,[person])).rows[0].id;
  const grant=(await db.pool.query(`INSERT INTO network.dot_oauth_grants(environment,person_id,collaborator_id,
    client_id,resource,scope,code_hash,code_challenge,redirect_uri,code_used_at)
    VALUES('test',$1,$2,'farejador-dot',$3,'farejador.read',$4,$5,'https://chatgpt.com/connector_platform_oauth_redirect',now()) RETURNING id`,
  [person,collaborator,origin+'/admin/dot/mcp',randomBytes(32).toString('hex'),'a'.repeat(43)])).rows[0].id;
  identity={person_id:person,collaborator_id:collaborator,grant_id:grant};
  token='da_'+randomBytes(32).toString('hex');
  await db.pool.query(`INSERT INTO network.dot_oauth_tokens(environment,grant_id,access_hash,refresh_hash)
    VALUES('test',$1,$2,$3)`,[grant,createHash('sha256').update(token).digest('hex'),randomBytes(32).toString('hex')]);
  subscriptions=await import('../../src/admin/dot/events/subscriptions.js');
  queue=await import('../../src/admin/dot/events/queue.js');delivery=await import('../../src/admin/dot/events/delivery.js');
  snapshots=await import('../../src/admin/dot/events/snapshots.js');
  await(await import('../../src/admin/dot/events/worker.js')).initializeDotEvents(db.pool);
  app=Fastify();await(await import('../../src/admin/dot/route.js')).registerDotRoutes(app);await app.ready();
},240000);
beforeEach(async()=>{
  await db.pool.query(`DELETE FROM network.dot_event_subscriptions;DELETE FROM ops.dot_monitor_targets;
    TRUNCATE network.dot_event_settings,network.dot_event_settings_history,ops.dot_external_health;
    UPDATE network.dot_oauth_grants SET revoked_at=NULL,expires_at=now()+interval '30 days';`);
});
afterAll(async()=>{if(app)await app.close();await(await import('../../src/persistence/db.js')).pool.end();if(db)await stopPostgres(db);});

function input(args:object={},name=event,key=secret) {return {name,arguments:args,delivery:{mode:'webhook',url,secret:key},cursor:null};}
async function subscribe(args:object={},name=event) {return subscriptions.subscribe(identity,input(args,name),db.pool,echo);}
async function conversation(account=1,environment='test') {
  const n=++count;
  const contact=(await db.pool.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name)
    VALUES($1,$2,'Contato teste') RETURNING id`,[environment,n])).rows[0].id;
  const id=(await db.pool.query(`INSERT INTO core.conversations(environment,chatwoot_account_id,chatwoot_conversation_id,
    contact_id,channel_type,current_status,started_at,last_activity_at)
    VALUES($1,$2,$3,$4,'whatsapp','open',now(),now()) RETURNING id`,[environment,account,n,contact])).rows[0].id;
  return {id,n,contact,environment};
}
async function message(c:Awaited<ReturnType<typeof conversation>>,type=0,age=0,privateMessage=false) {
  return (await db.pool.query(`INSERT INTO core.messages(environment,conversation_id,chatwoot_conversation_id,chatwoot_message_id,
    sender_type,message_type,content,sent_at,last_event_at,is_private)
    VALUES($1,$2,$3,$4,$5,$6,'CONTEUDO-SENSIVEL',$7,$7,$8) RETURNING id`,
  [c.environment,c.id,c.n,++count,type===0?'contact':'user',type,new Date(Date.now()-age*60000),privateMessage])).rows[0].id;
}
async function collect() {
  await db.pool.query(`UPDATE ops.dot_monitor_targets SET due_at=now()-interval '1 second' WHERE environment='test'`);
  await queue.collectEvents(db.pool);
}
function rpc(method:string,params:Record<string,unknown>={},headers:Record<string,string>={}) {
  return app.inject({method:'POST',url:'/admin/dot/mcp',headers:{host:'farejador.example',authorization:'Bearer '+token,
    'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2026-07-28',
    'mcp-method':method,...(typeof params.name==='string'?{'mcp-name':params.name}:{}),...headers},payload:{jsonrpc:'2.0',id:1,method,
      params:{...params,_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28',
        'io.modelcontextprotocol/clientInfo':{name:'test',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}}}});
}

it('controles exigem sessão humana de dono, mesma origem e versão; guardam histórico imutável',async()=>{
 const {mintMatrizAdminSessionForPerson,ADMIN_SESSION_COOKIE}=await import('../../src/admin/session.js');
 const session=await mintMatrizAdminSessionForPerson('test',identity.person_id,identity.collaborator_id,db.pool);
 const headers={cookie:`${ADMIN_SESSION_COOKIE}=${session!.sessionToken}`,host:'farejador.example',origin:'http://farejador.example'};
 const path='/admin/api/dot/alerts';
 expect((await app.inject({url:path})).statusCode).toBe(401);
 expect((await app.inject({url:path,headers:{authorization:'Bearer '+token}})).statusCode).toBe(401);
 const config=(await app.inject({url:path,headers})).json();expect(config.version).toBe(0);
 expect(Object.values(config.settings.events).filter(Boolean)).toHaveLength(2);
 expect((await app.inject({method:'PUT',url:path,headers:{...headers,origin:'https://evil.example'},payload:{version:0,settings:config.settings}})).statusCode).toBe(403);
 const payload={version:0,settings:{...config.settings,paused:true}};
 expect((await app.inject({method:'PUT',url:path,headers,payload})).json().version).toBe(1);
 expect((await app.inject({method:'PUT',url:path,headers,payload})).statusCode).toBe(409);
 expect((await db.pool.query('SELECT environment,version,updated_by FROM network.dot_event_settings_history')).rows)
  .toEqual([{environment:'test',version:1,updated_by:identity.person_id}]);
 await expect(db.pool.query('UPDATE network.dot_event_settings_history SET version=2')).rejects.toThrow('immutable');
 for(const table of ['network.dot_event_settings','network.dot_event_settings_history','ops.dot_external_health'])
  expect((await db.pool.query("SELECT has_table_privilege('farejador_partner_app',$1,'SELECT') allowed",[table])).rows[0].allowed).toBe(false);
 const settings=await import('../../src/admin/dot/events/settings.js');
 await expect(settings.saveSettings(payload.settings,1,randomUUID(),db.pool)).rejects.toThrow('owner_required');
});
it('pausar cancela pendências; teto por proprietário abrange assinaturas diferentes',async()=>{
 const settings=await import('../../src/admin/dot/events/settings.js');
 const a=await conversation(),b=await conversation();await subscribe({ids:[a.id]});await subscribe({ids:[b.id]});
 await message(a);await message(b);await collect();
 const config=settings.defaultSettings();config.max_per_hour=1;
 await settings.saveSettings(config,0,identity.person_id,db.pool);
 const send=vi.fn(async()=>({status:200,body:''}));await delivery.deliverEvents(db.pool,send);
 expect(send).toHaveBeenCalledTimes(1);
 config.paused=true;await settings.saveSettings(config,1,identity.person_id,db.pool);
 expect((await db.pool.query("SELECT count(*)::int n FROM ops.dot_event_deliveries WHERE status='pending'")).rows[0].n).toBe(0);
 await delivery.deliverEvents(db.pool,send);expect(send).toHaveBeenCalledTimes(1);
});
it('fontes novas executam SQL real em READ ONLY e fontes desligadas não inventam resultado',async()=>{
 const config=(await import('../../src/shared/config/env.js')).env,old={MATRIZ_CENTRAL_LEDGER:config.MATRIZ_CENTRAL_LEDGER,
  MARKETING_META_ENABLED:config.MARKETING_META_ENABLED,MARKETING_SYNC_ENABLED:config.MARKETING_SYNC_ENABLED,
  GOOGLE_ADS_ENABLED:config.GOOGLE_ADS_ENABLED,AGENT_V2_WORKER_ENABLED:config.AGENT_V2_WORKER_ENABLED,BOT_OUTBOX:config.BOT_OUTBOX};
 const settings=await import('../../src/admin/dot/events/settings.js'),value=settings.defaultSettings();
 for(const name of Object.keys(value.events))value.events[name as keyof typeof value.events]=true;
 await settings.saveSettings(value,0,identity.person_id,db.pool);
 const {withDotReadOnly}=await import('../../src/admin/dot/read-only.js');
 const {systemSignals}=await import('../../src/admin/dot/events/signals-system.js');
 const {financeSignals}=await import('../../src/admin/dot/events/signals-finance.js');
 const {marketingSignals}=await import('../../src/admin/dot/events/signals-marketing.js');
 const {restockSignals}=await import('../../src/admin/dot/events/signals-stock.js');
 try {
  Object.assign(config,{MATRIZ_CENTRAL_LEDGER:true,MARKETING_META_ENABLED:true,MARKETING_SYNC_ENABLED:true,GOOGLE_ADS_ENABLED:true,AGENT_V2_WORKER_ENABLED:true,BOT_OUTBOX:true});
  for(const detector of [systemSignals,financeSignals,marketingSignals,restockSignals])
   expect(Array.isArray(await withDotReadOnly(reader=>detector(reader,value,new Date()),db.pool))).toBe(true);
  config.MATRIZ_CENTRAL_LEDGER=false;
  const {readSignals,signalSourceStatus}=await import('../../src/admin/dot/events/signals.js');
  await expect(readSignals('farejador.financeiro.atencao',db.pool)).rejects.toThrow('central_ledger_disabled');
  expect(signalSourceStatus()['farejador.financeiro.atencao'].available).toBe(false);
 }finally{Object.assign(config,old);}
});
it('procura agrupa contatos distintos, exclui outra conta, desconhecido e estoque disponível; sinal resolve sem alterar buscas',async()=>{
 const settings=await import('../../src/admin/dot/events/settings.js'),value=settings.defaultSettings();value.events['farejador.estoque.procura']=true;value.demand_contacts=2;
 await settings.saveSettings(value,0,identity.person_id,db.pool);
 const a=await conversation(),b=await conversation(),other=await conversation(2);
 const search=async(c:typeof a,stores:unknown,measure='110/90-17')=>db.pool.query(`INSERT INTO ops.bot_stock_searches(environment,conversation_id,search_key,tool_name,measure,stores)
  VALUES('test',$1,$2,'buscar_produto',$3,$4)`,[c.id,randomUUID(),measure,JSON.stringify(stores)]);
 await search(a,[{available:false}]);await search(a,[{available:false}]);await search(other,[{available:false}]);await search(b,[]);await search(b,[{available:true}]);
 const {readSignals}=await import('../../src/admin/dot/events/signals.js');
 expect(await readSignals('farejador.estoque.procura',db.pool)).toEqual([]);
 await search(b,[{available:false}]);
 const signal=(await readSignals('farejador.estoque.procura',db.pool))[0]!;expect(signal.data.evidence).toMatchObject({distinct_contacts:2});
 await subscribe({},'farejador.estoque.procura');const sub=(await subscriptions.activeSubscriptions(db.pool))[0]!;
 await queue.enqueueSnapshot(db.pool,sub,signal,new Date());
 await db.pool.query('UPDATE core.contacts SET deleted_at=now() WHERE id=$1',[b.contact]);
 const send=vi.fn(async()=>({status:200,body:''}));await delivery.deliverEvents(db.pool,send);expect(send).not.toHaveBeenCalled();
 expect((await db.pool.query('SELECT count(*)::int n FROM ops.bot_stock_searches WHERE conversation_id=$1',[b.id])).rows[0].n).toBe(3);
});
it('inconsistência usa último turno entregue; resposta posterior remove bloqueio antigo',async()=>{
 const settings=await import('../../src/admin/dot/events/settings.js'),value=settings.defaultSettings();value.events['farejador.atendimento.inconsistencia']=true;
 await settings.saveSettings(value,0,identity.person_id,db.pool);
 const c=await conversation(),trigger=await message(c);
 await db.pool.query(`INSERT INTO agent.turns(environment,conversation_id,trigger_message_id,agent_version,context_hash,status,actions,created_at)
  VALUES('test',$1,$2,'v2',$3,'delivered',$4,now()-interval '1 minute')`,[c.id,trigger,randomUUID(),JSON.stringify([{role:'tool',content:'{"erro":"preco_alterado"}'}])]);
 const {readSignals}=await import('../../src/admin/dot/events/signals.js');
 expect(await readSignals('farejador.atendimento.inconsistencia',db.pool)).toHaveLength(1);
 await db.pool.query(`INSERT INTO agent.turns(environment,conversation_id,trigger_message_id,agent_version,context_hash,status,actions)
  VALUES('test',$1,$2,'v2',$3,'delivered','[]')`,[c.id,await message(c),randomUUID()]);
 expect(await readSignals('farejador.atendimento.inconsistencia',db.pool)).toEqual([]);
});
it('monitor externo exige falhas consecutivas, deduplica o caso e recuperação cancela envio',async()=>{
 const settings=await import('../../src/admin/dot/events/settings.js'),value=settings.defaultSettings();value.events['farejador.sistema.atencao']=true;
 await settings.saveSettings(value,0,identity.person_id,db.pool);await subscribe({},'farejador.sistema.atencao');
 const {recordExternalHealth,readExternalHealth}=await import('../../src/admin/dot/events/external-health.js');
 const base=new Date(),now=new Date(base.getTime()+2000);
 await recordExternalHealth(db.pool,false,503,base);expect(await readExternalHealth(db.pool,value,base)).toBeNull();
 await recordExternalHealth(db.pool,false,0,new Date(base.getTime()+1000));await recordExternalHealth(db.pool,false,503,now);
 const snapshot=(await readExternalHealth(db.pool,value,now))!,sub=(await subscriptions.activeSubscriptions(db.pool))[0]!;
 await queue.enqueueSnapshot(db.pool,sub,snapshot,now,now);await queue.enqueueSnapshot(db.pool,sub,snapshot,now,now);
 expect((await db.pool.query('SELECT count(*)::int n FROM ops.dot_event_deliveries')).rows[0].n).toBe(1);
 const recovered=new Date(base.getTime()+3000);await recordExternalHealth(db.pool,true,200,recovered);
 const send=vi.fn(async()=>({status:200,body:''}));await delivery.deliverEvents(db.pool,send,recovered);expect(send).not.toHaveBeenCalled();
 await recordExternalHealth(db.pool,false,503,new Date(base.getTime()+240000));
 expect((await db.pool.query('SELECT consecutive_failures FROM ops.dot_external_health')).rows[0].consecutive_failures).toBe(1);
});
it('aumentar intervalo pelo painel também segura aviso que já estava na fila',async()=>{
 await subscribe();const c=await conversation();await message(c);await collect();
 const send=vi.fn(async()=>({status:200,body:''}));await delivery.deliverEvents(db.pool,send);
 await message(c,1);await collect();
 await db.pool.query("UPDATE ops.dot_event_deliveries SET not_before=now() WHERE status='pending'");
 const settings=await import('../../src/admin/dot/events/settings.js'),value=settings.defaultSettings();value.cooldown_minutes=60;
 await settings.saveSettings(value,0,identity.person_id,db.pool);await delivery.deliverEvents(db.pool,send);
 expect(send).toHaveBeenCalledTimes(1);
 expect((await db.pool.query("SELECT not_before>now()+interval '55 minutes' delayed FROM ops.dot_event_deliveries WHERE status='pending'")).rows[0].delayed).toBe(true);
});
it('aviso vencido é cancelado mesmo quando a fonte está indisponível',async()=>{
 await subscribe();const c=await conversation();await message(c);await collect();
 await db.pool.query("UPDATE ops.dot_event_deliveries SET created_at=now()-interval '25 hours'");
 const spy=vi.spyOn(snapshots,'readSnapshot').mockRejectedValue(new Error('fonte indisponível'));
 try{await delivery.deliverEvents(db.pool,async()=>{throw Error('não enviar');});
  expect((await db.pool.query('SELECT status FROM ops.dot_event_deliveries')).rows[0].status).toBe('cancelled');expect(spy).not.toHaveBeenCalled();
 }finally{spy.mockRestore();}
});
it('financeiro inclui contas no prazo configurado, exclui futuro/ambiente e mantém livro intacto',async()=>{
 const config=(await import('../../src/shared/config/env.js')).env,old=config.MATRIZ_CENTRAL_LEDGER;config.MATRIZ_CENTRAL_LEDGER=true;
 const settings=await import('../../src/admin/dot/events/settings.js'),value=settings.defaultSettings();value.events['farejador.financeiro.atencao']=true;
 await settings.saveSettings(value,0,identity.person_id,db.pool);
 const post=async(environment:string,days:number)=>(await db.pool.query(`SELECT finance.post_matriz_ledger_transaction(
  $1::env_t,'manual.test',$2,'sale',150,current_date,'Conta de teste','owner:test',$3::jsonb,current_date+$4::int,NULL,'{}') id`,
  [environment,randomUUID(),JSON.stringify([{account_code:'accounts_receivable',account_class:'asset',side:'debit',amount:150},
   {account_code:'sales_revenue',account_class:'revenue',side:'credit',amount:150}]),days])).rows[0].id;
 const due=await post('test',1),future=await post('test',20),other=await post('prod',1);
 const before=(await db.pool.query('SELECT count(*)::int n FROM finance.matriz_ledger_transactions')).rows[0].n;
 try {
  const {readSignals}=await import('../../src/admin/dot/events/signals.js');const rows=await readSignals('farejador.financeiro.atencao',db.pool);
  const evidence=rows.map(row=>row.data.evidence as Record<string,unknown>);
  expect(evidence).toContainEqual(expect.objectContaining({obligation_id:due,balance_brl:'150.00',currency:'BRL'}));
  expect(evidence.some(row=>row.obligation_id===future||row.obligation_id===other)).toBe(false);
  expect((await db.pool.query('SELECT count(*)::int n FROM finance.matriz_ledger_transactions')).rows[0].n).toBe(before);
 }finally{config.MATRIZ_CENTRAL_LEDGER=old;}
});
it('marketing considera só campanhas próprias verificadas e métricas desatualizadas pedem conferência',async()=>{
 const config=(await import('../../src/shared/config/env.js')).env,old=config.MARKETING_META_ENABLED;config.MARKETING_META_ENABLED=true;
 const settings=await import('../../src/admin/dot/events/settings.js'),value=settings.defaultSettings();value.events['farejador.marketing.atencao']=true;
 await settings.saveSettings(value,0,identity.person_id,db.pool);
 const sync=(await db.pool.query(`INSERT INTO marketing.meta_sync_runs(environment,trigger_type,status,window_since,window_until,finished_at)
  VALUES('test','manual','succeeded',current_date,current_date,now()) RETURNING id`)).rows[0].id;
 await db.pool.query("INSERT INTO marketing.meta_identity_accounts(environment,ad_account_id,sync_run_id) VALUES('test','alerts-verified',$1)",[sync]);
 await db.pool.query(`INSERT INTO marketing.campaign_scopes(environment,ad_account_id,campaign_id,scope,classification_reason,classified_by,classified_at)
  VALUES('test','alerts-verified','991','matrix','Escopo de teste','qa',now()),('test','alerts-unverified','992','matrix','Escopo de teste','qa',now()),
  ('test','alerts-verified','993','external','Escopo de teste','qa',now());
  INSERT INTO marketing.meta_ad_identities(environment,ad_account_id,ad_id,campaign_id,scope)
   VALUES('test','alerts-verified','991','991','matrix'),('test','alerts-verified','993','993','external');
  INSERT INTO marketing.meta_insights_daily(environment,ad_account_id,api_version,account_currency,entity_level,entity_id,campaign_id,metric_date,spend,conversations)
  VALUES('test','alerts-verified','v26.0','BRL','ad','991','991',(now() AT TIME ZONE 'America/Sao_Paulo')::date,150,0),
   ('test','alerts-unverified','v26.0','BRL','ad','992','992',(now() AT TIME ZONE 'America/Sao_Paulo')::date,900,0),
   ('test','alerts-verified','v26.0','BRL','ad','993','993',(now() AT TIME ZONE 'America/Sao_Paulo')::date,900,0)`);
 try {
  const {readSignals}=await import('../../src/admin/dot/events/signals.js');
  const rows=await readSignals('farejador.marketing.atencao',db.pool);
  expect(rows).toHaveLength(1);expect(rows[0]!.data).toMatchObject({reason:'verba_com_poucos_resultados_registrados',evidence:{campaign_id:'991',qualified_conversations:null,realized_sales:null}});
  await db.pool.query("UPDATE marketing.meta_insights_daily SET collected_at=now()-interval '3 days' WHERE environment='test' AND campaign_id='991'");
  expect((await readSignals('farejador.marketing.atencao',db.pool))[0]!.data.reason).toBe('conferir_rastreamento_e_atualizacao');
 }finally{config.MARKETING_META_ENABLED=old;}
});
it('monitor externo envia somente o próprio sinal e não consome pendências de atendimento',async()=>{
 const settings=await import('../../src/admin/dot/events/settings.js'),value=settings.defaultSettings();value.events['farejador.sistema.atencao']=true;
 await settings.saveSettings(value,0,identity.person_id,db.pool);await subscribe({},'farejador.sistema.atencao');await subscribe();
 const c=await conversation();await message(c);await collect();
 const {runExternalCycle}=await import('../../src/admin/dot/events/external-cycle.js');
 const probe=vi.fn(async()=>({status:503,body:''})),send=vi.fn(async()=>({status:200,body:''})),base=Date.now();
 for(let n=0;n<3;n++)await runExternalCycle(db.pool,probe,send,new Date(base+n*1000));
 expect(send).toHaveBeenCalledTimes(1);expect(JSON.parse(send.mock.calls[0]![1]).data.reason).toBe('farejador_indisponivel_confirmado_por_monitor_externo');
 expect(probe).toHaveBeenCalledWith(origin+'/healthz');
 expect((await db.pool.query("SELECT status FROM ops.dot_event_deliveries WHERE kind='conversation'")).rows[0].status).toBe('pending');
});
it('MCP 2.0 descobre eventos e ferramentas com autenticação, cabeçalhos e cache privado',async()=>{
  expect((await rpc('server/discover')).json()).toMatchObject({result:{resultType:'complete',supportedVersions:['2026-07-28'],capabilities:{events:{}},cacheScope:'private'}});
  expect((await rpc('events/list')).json().result.events).toHaveLength(8);
  expect((await rpc('tools/list')).json().result.tools).toHaveLength(31);
  expect((await rpc('events/list',{}, {authorization:''})).statusCode).toBe(401);
  expect((await rpc('tools/list',{}, {'mcp-method':'tools/call'})).json().error.code).toBe(-32020);
  expect((await rpc('tools/call',{name:'listar_fontes_matriz',arguments:{}},{'mcp-name':'wrong'})).json().error.code).toBe(-32020);
  expect((await rpc('tools/call',{name:'listar_fontes_matriz',arguments:{}})).json().result.isError).not.toBe(true);
  const legacy=await app.inject({method:'POST',url:'/admin/dot/mcp',headers:{host:'farejador.example',authorization:'Bearer '+token,
    'content-type':'application/json',accept:'application/json, text/event-stream'},payload:{jsonrpc:'2.0',id:1,method:'tools/list'}});
  expect(legacy.json().result.tools).toHaveLength(31);
});
it('challenge é obrigatório; filtros canônicos tornam a assinatura idempotente, com segredo cifrado',async()=>{
  const id=randomUUID(),send=vi.fn(echo);
  const a=await subscriptions.subscribe(identity,input({ids:[id,id]}),db.pool,send);
  const b=await subscriptions.subscribe(identity,input({ids:[id]}),db.pool,send);
  expect(a.id).toBe(b.id);expect(send).toHaveBeenCalledTimes(1);
  const row=(await db.pool.query('SELECT * FROM network.dot_event_subscriptions')).rows[0];
  expect(JSON.stringify(row)).not.toContain(secret);expect(row.expires_at.getTime()).toBeLessThanOrEqual(Date.now()+86400_000);
  await expect(subscriptions.subscribe(identity,{...input(),delivery:{mode:'webhook',url:url+'/bad',secret}},db.pool,
    async()=>({status:200,body:'{"challenge":"wrong"}'}))).rejects.toThrow();
  expect(await subscriptions.activeSubscriptions(db.pool)).toHaveLength(1);
});
it('unsubscribe durante verificação impede ativação tardia',async()=>{
  const send:WebhookSender=async(u,b,h)=>{
    await subscriptions.unsubscribe(identity,{name:event,arguments:{},delivery:{mode:'webhook',url}},db.pool);
    return echo(u,b,h);
  };
  await expect(subscriptions.subscribe(identity,input(),db.pool,send)).rejects.toThrow('subscription_changed');
  expect(await subscriptions.activeSubscriptions(db.pool)).toHaveLength(0);
});
it('refresh concorrente não substitui o segredo da assinatura mais nova',async()=>{
  await subscribe();const newer='whsec_'+Buffer.alloc(32,5).toString('base64');
  const send:WebhookSender=async(u,b,h)=>{
    await subscriptions.subscribe(identity,input({},event,newer),db.pool,echo);return echo(u,b,h);
  };
  await expect(subscriptions.subscribe(identity,input({},event,'whsec_'+Buffer.alloc(32,4).toString('base64')),db.pool,send))
    .rejects.toThrow('subscription_changed');
  const row=(await subscriptions.activeSubscriptions(db.pool))[0]!;
  expect((await import('../../src/admin/dot/events/crypto.js')).unseal(row.secret_ciphertext,row.id)).toBe(newer);
});
it('fila agrupa mensagens e não inclui conteúdo pessoal no evento; só leitura comercial',async()=>{
  await subscribe();const c=await conversation();await message(c);await message(c,1);
  expect((await db.pool.query('SELECT count(*)::int n FROM ops.dot_monitor_targets')).rows[0].n).toBe(1);
  expect((await db.pool.query('SELECT revision FROM ops.dot_monitor_targets')).rows[0].revision).toBe('3');
  await queue.collectEvents(db.pool);
  expect((await db.pool.query('SELECT count(*)::int n FROM ops.dot_event_deliveries')).rows[0].n).toBe(0);
  await collect();await collect();
  const rows=(await db.pool.query('SELECT * FROM ops.dot_event_deliveries')).rows;
  expect(rows).toHaveLength(1);expect(JSON.stringify(rows)).not.toContain('CONTEUDO-SENSIVEL');
  const send=vi.fn(async()=>({status:200,body:''}));await delivery.deliverEvents(db.pool,send);await delivery.deliverEvents(db.pool,send);
  expect(send).toHaveBeenCalledTimes(1);
  expect((await db.pool.query('SELECT count(*)::int n FROM core.messages WHERE conversation_id=$1',[c.id])).rows[0].n).toBe(2);
});
it('filtros, conta Chatwoot, mensagens privadas e ambiente são respeitados',async()=>{
  const allowed=await conversation();await subscribe({ids:[allowed.id]});
  await message(allowed);const outside=await conversation();await message(outside);
  const otherAccount=await conversation(2);await message(otherAccount);
  const production=await conversation(1,'prod');await message(production);
  const privateOnly=await conversation();await message(privateOnly,0,0,true);
  await collect();
  expect((await db.pool.query('SELECT entity_id FROM ops.dot_event_deliveries')).rows).toEqual([{entity_id:allowed.id}]);
  expect(await snapshots.readSnapshot('conversation',otherAccount.id,db.pool)).toBeNull();
  expect(await snapshots.readSnapshot('conversation',production.id,db.pool)).toBeNull();
});
it('espera gera uma nova avaliação, mas resposta antes do envio cancela a pendência',async()=>{
  await subscribe();const c=await conversation();await message(c,0,11);await collect();
  expect((await db.pool.query('SELECT payload FROM ops.dot_event_deliveries')).rows[0].payload.data.reason).toBe('aguardando_resposta');
  await message(c,1);const send=vi.fn(async()=>({status:200,body:''}));await delivery.deliverEvents(db.pool,send);
  expect(send).not.toHaveBeenCalled();
  expect((await db.pool.query('SELECT status FROM ops.dot_event_deliveries')).rows[0].status).toBe('cancelled');
});
it('encerramento dispara revisão de pendência sem afirmar que houve erro',async()=>{
  await subscribe();const c=await conversation();await message(c);
  await db.pool.query(`UPDATE core.conversations SET current_status='resolved',resolved_at=now() WHERE id=$1`,[c.id]);
  await collect();expect((await db.pool.query('SELECT payload FROM ops.dot_event_deliveries')).rows[0].payload.data.reason).toBe('conversa_encerrada');
});
it('cooldown impede avisos seguidos do mesmo caso e problemas iguais não repetem',async()=>{
  await subscribe();const c=await conversation();await message(c,1);await collect();
  const send=vi.fn(async()=>({status:200,body:''}));await delivery.deliverEvents(db.pool,send);
  await message(c,1);await collect();await delivery.deliverEvents(db.pool,send);
  expect(send).toHaveBeenCalledTimes(1);
  const pending=(await db.pool.query(`SELECT not_before FROM ops.dot_event_deliveries WHERE status='pending'`)).rows[0];
  expect(pending.not_before.getTime()).toBeGreaterThan(Date.now()+9*60000);
});
it('revogação do grant impede envio pendente e assinatura ultrapassando validade',async()=>{
  await subscribe();const c=await conversation();await message(c);await collect();
  await db.pool.query('UPDATE network.dot_oauth_grants SET revoked_at=now() WHERE id=$1',[identity.grant_id]);
  const send=vi.fn(async()=>({status:200,body:''}));await delivery.deliverEvents(db.pool,send);
  expect(send).not.toHaveBeenCalled();expect(await subscriptions.activeSubscriptions(db.pool)).toHaveLength(0);
  await expect(subscribe()).rejects.toThrow('authorization_revoked');
});
it('retentativa mantém evento/bytes e 410 encerra a assinatura sem repetir',async()=>{
  await subscribe();const c=await conversation();await message(c);await collect();
  const send=vi.fn(async()=>({status:503,body:''}));await delivery.deliverEvents(db.pool,send);
  await db.pool.query(`UPDATE ops.dot_event_deliveries SET not_before=now()-interval '1 second'`);
  send.mockImplementation(async()=>({status:410,body:''}));await delivery.deliverEvents(db.pool,send);
  expect(send).toHaveBeenCalledTimes(2);expect(send.mock.calls[0]![1]).toBe(send.mock.calls[1]![1]);
  await delivery.deliverEvents(db.pool,send);expect(send).toHaveBeenCalledTimes(2);
  expect(await subscriptions.activeSubscriptions(db.pool)).toHaveLength(0);
});
it('entrega vencida precisa de data registrada e conclusão cancela aviso',async()=>{
  await subscribe({},'farejador.entrega.atencao');const c=await conversation();
  const unit=(await db.pool.query(`INSERT INTO core.units(environment,slug,name) VALUES('test','main','Matriz')
    ON CONFLICT(environment,slug) DO UPDATE SET name=EXCLUDED.name RETURNING id`)).rows[0].id;
  const id=(await db.pool.query(`INSERT INTO commerce.orders(environment,unit_id,contact_id,total_amount,status,
    fulfillment_mode,payment_method,delivery_status,scheduled_delivery_date,delivery_address)
    VALUES('test',$1,$2,100,'open','delivery','pix','pending',current_date-1,'Rua de teste 1') RETURNING id`,[unit,c.contact])).rows[0].id;
  await db.pool.query("UPDATE ops.dot_monitor_targets SET changed_at=now()-interval '1 hour' WHERE entity_id=$1",[id]);
  await collect();expect((await db.pool.query('SELECT payload FROM ops.dot_event_deliveries')).rows[0].payload.data.reason).toBe('entrega_atrasada');
  await db.pool.query(`UPDATE commerce.orders SET delivery_status='delivered',delivered_at=now() WHERE id=$1`,[id]);
  const send=vi.fn(async()=>({status:200,body:''}));await delivery.deliverEvents(db.pool,send);expect(send).not.toHaveBeenCalled();
  await db.pool.query(`UPDATE commerce.orders SET delivery_status='pending',scheduled_delivery_date=NULL WHERE id=$1`,[id]);
  const unknown=await snapshots.readSnapshot('order',id,db.pool);expect(unknown!.data.reason).toBe('entrega_agendada');
  const settings=await import('../../src/admin/dot/events/settings.js'),value=settings.defaultSettings();value.delivery_without_date=true;
  await settings.saveSettings(value,0,identity.person_id,db.pool);
  expect((await snapshots.readSnapshot('order',id,db.pool,new Date(Date.now()+25*3600000)))!.data.reason).toBe('entrega_sem_atualizacao_e_sem_prazo');
});
it('tabelas privadas ficam fora do catálogo e do acesso do parceiro',async()=>{
  const sources=(await import('../../src/admin/dot/full-catalog.js')).fullSources;
  expect(sources.some(s=>/dot_event|dot_monitor/.test(s.key))).toBe(false);
  for(const table of ['network.dot_event_subscriptions','ops.dot_monitor_targets','ops.dot_event_deliveries']) {
    const permission=await db.pool.query(`SELECT has_table_privilege('farejador_partner_app',$1,'SELECT') allowed`,[table]);
    expect(permission.rows[0].allowed).toBe(false);
  }
  const result=(await rpc('tools/call',{name:'consultar_acompanhamento_matriz',arguments:{}})).json();
  expect(result.result.structuredContent.enabled).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/secret_ciphertext|callback_url|whsec_/);
});

it('reconexão muda a geração e coletor antigo não revive avisos',async()=>{
  await subscribe();const old=(await subscriptions.activeSubscriptions(db.pool))[0]!;
  const c=await conversation();await message(c);const snap=(await snapshots.readSnapshot('conversation',c.id,db.pool))!;
  await subscriptions.unsubscribe(identity,{name:event,arguments:{},delivery:{mode:'webhook',url}},db.pool);
  await subscribe();const fresh=(await subscriptions.activeSubscriptions(db.pool))[0]!;
  expect(old.id).toBe(fresh.id);expect(old.activation_id).not.toBe(fresh.activation_id);
  await queue.enqueueSnapshot(db.pool,old,snap,new Date());
  expect((await db.pool.query('SELECT count(*)::int n FROM ops.dot_event_deliveries')).rows[0].n).toBe(0);
  await queue.enqueueSnapshot(db.pool,fresh,snap,new Date());
  expect((await db.pool.query('SELECT activation_id FROM ops.dot_event_deliveries')).rows[0].activation_id).toBe(fresh.activation_id);
});
it('expiração cancela envio e renovação normal preserva geração e deduplicação',async()=>{
  await subscribe();const first=(await subscriptions.activeSubscriptions(db.pool))[0]!;
  await subscribe();expect((await subscriptions.activeSubscriptions(db.pool))[0]!.activation_id).toBe(first.activation_id);
  const c=await conversation();await message(c);await collect();
  await db.pool.query(`UPDATE network.dot_event_subscriptions SET expires_at=now()-interval '1 second'`);
  const send=vi.fn(async()=>({status:200,body:''}));await delivery.deliverEvents(db.pool,send);expect(send).not.toHaveBeenCalled();
  await subscribe();expect((await subscriptions.activeSubscriptions(db.pool))[0]!.activation_id).not.toBe(first.activation_id);
});
it('contato apagado cancela evento antes do envio',async()=>{
  await subscribe();const c=await conversation();await message(c);await collect();
  await db.pool.query('UPDATE core.contacts SET deleted_at=now() WHERE id=$1',[c.contact]);
  const send=vi.fn(async()=>({status:200,body:''}));await delivery.deliverEvents(db.pool,send);expect(send).not.toHaveBeenCalled();
});
it('rotação assina com chave nova e antiga durante a janela',async()=>{
  await subscribe();const c=await conversation();await message(c);await collect();
  await subscriptions.subscribe(identity,input({},event,'whsec_'+Buffer.alloc(32,6).toString('base64')),db.pool,echo);
  await subscriptions.subscribe(identity,input({},event,'whsec_'+Buffer.alloc(32,6).toString('base64')),db.pool,echo);
  const send=vi.fn(async()=>({status:200,body:''}));await delivery.deliverEvents(db.pool,send);
  expect(send.mock.calls[0]![2]['webhook-signature'].split(' ')).toHaveLength(2);
});
it('revogação enquanto se lê o contexto é conferida de novo antes do POST',async()=>{
  await subscribe();const c=await conversation();await message(c);await collect();
  const original=db.pool.query.bind(db.pool);let revoked=false;
  const spy=vi.spyOn(db.pool,'query').mockImplementation((async(...args:unknown[])=>{
    const result=await Reflect.apply(original,db.pool,args);
    if(!revoked&&String(args[0]).includes('count(*)::int n FROM ops.dot_event_deliveries')) {
      revoked=true;await original('UPDATE network.dot_oauth_grants SET revoked_at=now() WHERE id=$1',[identity.grant_id]);
    }
    return result;
  }) as typeof db.pool.query);
  try {
    const send=vi.fn(async()=>({status:200,body:''}));await delivery.deliverEvents(db.pool,send);expect(send).not.toHaveBeenCalled();
  }finally{spy.mockRestore();}
});
it('teto de avaliações adia sem descartar e silêncio respeita horário local',async()=>{
  const config=(await import('../../src/shared/config/env.js')).env;
  const before={cap:config.DOT_EVENTS_MAX_PER_HOUR,start:config.DOT_EVENTS_QUIET_START_HOUR,end:config.DOT_EVENTS_QUIET_END_HOUR};
  try {
    config.DOT_EVENTS_MAX_PER_HOUR=1;
    await subscribe();const a=await conversation(),b=await conversation();await message(a);await message(b);await collect();
    const send=vi.fn(async()=>({status:200,body:''}));await delivery.deliverEvents(db.pool,send);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await db.pool.query(`SELECT count(*)::int n FROM ops.dot_event_deliveries WHERE status='pending'`)).rows[0].n).toBe(1);
    config.DOT_EVENTS_QUIET_START_HOUR=22;config.DOT_EVENTS_QUIET_END_HOUR=8;
    const hour=(await import('../../src/admin/dot/events/policy.js')).quietUntil(new Date('2026-10-24T02:00:00Z'));
    expect(hour?.toISOString()).toBe('2026-10-24T11:00:00.000Z');
  }finally{config.DOT_EVENTS_MAX_PER_HOUR=before.cap;config.DOT_EVENTS_QUIET_START_HOUR=before.start;config.DOT_EVENTS_QUIET_END_HOUR=before.end;}
});

it('dois workers concorrentes não enviam o mesmo evento',async()=>{
  await subscribe();const c=await conversation();await message(c);await collect();
  const {runEventCycle}=await import('../../src/admin/dot/events/worker.js');
  let started!:()=>void,release!:()=>void;
  const ready=new Promise<void>(resolve=>{started=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const send=vi.fn(async()=>{started();await gate;return {status:200,body:''};});
  const first=runEventCycle(db.pool,send);
  try {await ready;await runEventCycle(db.pool,send);expect(send).toHaveBeenCalledTimes(1);}
  finally{release();await first;}
  await runEventCycle(db.pool,send);expect(send).toHaveBeenCalledTimes(1);
});
it('assinatura e cancelamento funcionam pelo endpoint MCP 2.0',async()=>{
  const network=await import('../../src/admin/dot/events/https.js');
  const spy=vi.spyOn(network,'sendWebhook').mockImplementation(echo);
  try {
    const result=(await rpc('events/subscribe',input())).json();
    expect(result.result.id).toMatch(/^sub_/);expect(spy).toHaveBeenCalledTimes(1);
    const stop=(await rpc('events/unsubscribe',{name:event,arguments:{},delivery:{mode:'webhook',url}})).json();
    expect(stop.result.resultType).toBe('complete');expect(await subscriptions.activeSubscriptions(db.pool)).toHaveLength(0);
  }finally{spy.mockRestore();}
});
it('flag desligada mantém consultas e não anuncia eventos',async()=>{
  const config=(await import('../../src/shared/config/env.js')).env;const previous=config.DOT_EVENTS_ENABLED;
  try {
    config.DOT_EVENTS_ENABLED=false;
    expect((await rpc('server/discover')).json().result.capabilities.events).toBeUndefined();
    expect((await rpc('tools/list')).json().result.tools).toHaveLength(30);
    expect((await rpc('events/list')).statusCode).toBe(404);
  }finally{config.DOT_EVENTS_ENABLED=previous;}
});

it('chave inválida preserva HTTP e consultas, mas bloqueia descoberta, assinatura e envio de eventos',async()=>{
  const config=(await import('../../src/shared/config/env.js')).env;
  const worker=await import('../../src/admin/dot/events/worker.js');
  const network=await import('../../src/admin/dot/events/https.js');
  const spy=vi.spyOn(network,'sendWebhook').mockImplementation(echo);
  const valid=config.DOT_EVENTS_ENCRYPTION_KEY,fresh=Fastify();
  try {
    config.DOT_EVENTS_ENCRYPTION_KEY='';
    await expect(worker.initializeDotEvents(db.pool)).resolves.toMatchObject({enabled:false,reason:'invalid_encryption_key'});
    await(await import('../../src/admin/health.route.js')).registerHealthRoute(fresh);
    await fresh.ready();
    expect((await fresh.inject({method:'GET',url:'/livez'})).statusCode).toBe(200);
    expect((await rpc('server/discover')).json().result.capabilities.events).toBeUndefined();
    expect((await rpc('tools/list')).json().result.tools).toHaveLength(31);
    expect((await rpc('tools/call',{name:'listar_fontes_matriz',arguments:{}})).json().result.isError).not.toBe(true);
    const status=(await rpc('tools/call',{name:'consultar_acompanhamento_matriz',arguments:{}})).json().result.structuredContent;
    expect(status).toMatchObject({enabled:false,reason:'invalid_encryption_key',subscriptions:null,last_24h:null});
    expect((await rpc('events/list')).statusCode).toBe(404);
    expect((await rpc('events/subscribe',input())).statusCode).toBe(404);
    await worker.runEventCycle(db.pool,spy);
    expect(spy).not.toHaveBeenCalled();
    config.DOT_EVENTS_ENCRYPTION_KEY=valid;await worker.initializeDotEvents(db.pool);
    expect((await rpc('server/discover')).json().result.capabilities.events).toEqual({});
    expect((await rpc('events/subscribe',input())).json().result.id).toMatch(/^sub_/);
    expect(spy).toHaveBeenCalledTimes(1);
  }finally{config.DOT_EVENTS_ENCRYPTION_KEY=valid;await worker.initializeDotEvents(db.pool);spy.mockRestore();await fresh.close();}
});
