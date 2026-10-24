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
  app=Fastify();await(await import('../../src/admin/dot/route.js')).registerDotRoutes(app);await app.ready();
},240000);
beforeEach(async()=>{
  await db.pool.query(`DELETE FROM network.dot_event_subscriptions;DELETE FROM ops.dot_monitor_targets;
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

it('MCP 2.0 descobre eventos e ferramentas com autenticação, cabeçalhos e cache privado',async()=>{
  expect((await rpc('server/discover')).json()).toMatchObject({result:{resultType:'complete',supportedVersions:['2026-07-28'],capabilities:{events:{}},cacheScope:'private'}});
  expect((await rpc('events/list')).json().result.events).toHaveLength(2);
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
  await collect();expect((await db.pool.query('SELECT payload FROM ops.dot_event_deliveries')).rows[0].payload.data.reason).toBe('entrega_atrasada');
  await db.pool.query(`UPDATE commerce.orders SET delivery_status='delivered',delivered_at=now() WHERE id=$1`,[id]);
  const send=vi.fn(async()=>({status:200,body:''}));await delivery.deliverEvents(db.pool,send);expect(send).not.toHaveBeenCalled();
  await db.pool.query(`UPDATE commerce.orders SET delivery_status='pending',scheduled_delivery_date=NULL WHERE id=$1`,[id]);
  const unknown=await snapshots.readSnapshot('order',id,db.pool);expect(unknown!.data.reason).toBe('entrega_agendada');
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
