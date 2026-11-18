import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll,beforeAll,expect,it } from 'vitest';
import type { Pool } from 'pg';
import { applyMigrationFile,startPostgres,stopPostgres,type IntegrationDb } from './helpers/postgres.js';

let db:IntegrationDb, app:FastifyInstance, appPool:Pool;
const contact=randomUUID(), conversation=randomUUID(), foreign=randomUUID(), plain=randomUUID();
const question=randomUUID(), greeting=randomUUID(), acceptance=randomUUID(), turn=randomUUID(), order=randomUUID();
const generation=randomUUID(), quote=randomUUID();
let owner:string, product:string, mainId:string, ownerCookie:string, ownerToken:string, adminCookie:string, adminToken:string;
const panel='/admin/api/bot/chat/conversations', mobile='/api/caixa/chat/conversations';
let history0296:{status:number;data:Record<string,unknown>};
const day="date_trunc('minute',now())-interval '1 minute'";
async function identities(role:'owner'|'admin'){
  const person=randomUUID(),collaborator=randomUUID();
  await db.pool.query(`INSERT INTO network.partner_people (id,environment,username,password_hash)
    VALUES($1,'test',$2,'sintetica')`,[person,'historico-'+role]);
  await db.pool.query(`INSERT INTO network.matriz_collaborators
    (id,environment,person_id,display_name,job,panel_role,work_area,job_title)
    VALUES($1,'test',$2,$3,'vendedor',$3,'sales','Vendas')`,[collaborator,person,role]);
  const {mintMatrizAdminSessionForPerson,ADMIN_SESSION_COOKIE}=await import('../../src/admin/session.js');
  const {mintCaixaSessionForPerson}=await import('../../src/admin/caixa/queries.js');
  const p=await mintMatrizAdminSessionForPerson('test',person,collaborator,db.pool);
  const m=await mintCaixaSessionForPerson('test',person,collaborator,db.pool);
  return {person,cookie:ADMIN_SESSION_COOKIE+'='+p!.sessionToken,token:'Bearer '+m!.session_token};
}
beforeAll(async()=>{
  db=await startPostgres({throughMigration:'0296_milly_consulta_comercial.sql'});
  Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:db.connectionString,DATABASE_SSL:'false',
    CHATWOOT_ACCOUNT_ID:'44',CHATWOOT_HMAC_SECRET:'fixture',ADMIN_AUTH_TOKEN:'emergency-fixture',
    ADMIN_BEARER_FALLBACK_ENABLED:'true',MATRIZ_CAIXA_PORTAL:'true',MATRIZ_CUSTOMER_IDENTITY:'false'});
  ({pool:appPool}=await import('../../src/persistence/db.js'));
  const {registerCaixaRoute}=await import('../../src/admin/caixa/route.js');
  const {registerBotChatRoutes}=await import('../../src/admin/painel/route-bot-chat.js');
  app=Fastify();await registerCaixaRoute(app);registerBotChatRoutes(app);await app.ready();
  ({person:owner,cookie:ownerCookie,token:ownerToken}=await identities('owner'));
  ({cookie:adminCookie,token:adminToken}=await identities('admin'));
  await db.pool.query("INSERT INTO core.contacts(id,environment,chatwoot_contact_id,name) VALUES($1,'test',44000,'Cliente sintético')",[contact]);
  await db.pool.query(`INSERT INTO core.conversations(id,environment,chatwoot_conversation_id,chatwoot_account_id,contact_id,current_status,started_at)
    VALUES($1,'test',44001,44,$4,'resolved',now()),($2,'test',44002,66,$4,'open',now()),($3,'test',44003,44,$4,'open',now())`,[conversation,foreign,plain,contact]);
  await db.pool.query(`INSERT INTO core.messages(id,environment,conversation_id,chatwoot_conversation_id,chatwoot_message_id,
    sender_type,message_type,is_private,content,sent_at)
    VALUES($1,'test',$4,44001,1,'contact',0,false,'Boa tarde',${day}),
    ($2,'test',$4,44001,3,'contact',0,false,'Faz por 80?',${day}+interval '3 second'),
    ($3,'test',$4,44001,7,'contact',0,false,'Aceito',${day}+interval '15 second'),
    (gen_random_uuid(),'test',$4,44001,2,'user',1,false,'Mensagem de outro assunto',${day}+interval '2 second'),
    (gen_random_uuid(),'test',$4,44001,4,'contact',0,true,'Nota que não é pública',${day}+interval '4 second')`,
  [greeting,question,acceptance,conversation]);
  mainId=(await db.pool.query(`INSERT INTO core.units(environment,slug,name) VALUES('test','main','Matriz de teste')
    ON CONFLICT(environment,slug) DO UPDATE SET is_active=true RETURNING id`)).rows[0].id;
  product=(await db.pool.query(`INSERT INTO commerce.products(environment,product_code,product_name,product_type)
    VALUES('test','HIS-P','Pneu 110/70-13','tire') RETURNING id`)).rows[0].id;
  await db.pool.query(`INSERT INTO commerce.orders(id,environment,unit_id,contact_id,source_conversation_id,total_amount,fulfillment_mode,payment_method)
    VALUES($1,'test',$2,$3,$4,80,'pickup','pix')`,[order,mainId,contact,conversation]);
  await db.pool.query("INSERT INTO commerce.order_items(environment,order_id,product_id,quantity,unit_price) VALUES('test',$1,$2,1,80)",[order,product]);
  await db.pool.query("INSERT INTO ops.bot_order_attempts(environment,conversation_id,request_message_id,order_id) VALUES('test',$1,$2,$3)",[conversation,acceptance,order]);
  await db.pool.query("INSERT INTO ops.milly_consulta_config(environment,enabled,generation,owner_person_id) VALUES('test',false,$1,$2)",[generation,owner]);
  const legacy=(await db.pool.query(`INSERT INTO ops.milly_consultas
    (environment,generation,conversation_id,trigger_message_id,unit_id,product_id,quantity,payment_method,fulfillment_mode,
    offered_total_cents,catalog_unit_cents,freight_cents,state,decision)
    VALUES('test',$1,$2,$3,$4,$5,1,'pix','pickup',8000,11000,0,'declined','manter') RETURNING id`,
    [generation,conversation,question,mainId,product])).rows[0].id;
  const legacyResponse=await app.inject({url:panel+'/'+conversation+'/milly',headers:{cookie:ownerCookie}});
  history0296={status:legacyResponse.statusCode,data:legacyResponse.json()};
  await db.pool.query('DELETE FROM ops.milly_consultas WHERE id=$1',[legacy]);
  await applyMigrationFile(db.pool,'0297_milly_historico_consultas.sql');
  await db.pool.query(`INSERT INTO ops.milly_consultas
    (id,environment,generation,conversation_id,trigger_message_id,unit_id,product_id,quantity,payment_method,fulfillment_mode,
     offered_total_cents,catalog_unit_cents,freight_cents,state,decision,approved_total_cents,decided_by,
     created_at,context_read_at,context_snapshot,decided_at,published_at,published_provider_id,order_id,valid_until,decision_rationale)
    VALUES($1,'test',$2,$3,$4,$5,$6,1,'pix','pickup',8000,11000,0,'consumed','aceitar',8000,$7,
     ${day}+interval '4 second',${day}+interval '6 second','{"disponivel":100,"custo_unitario_centavos":5000}',
     ${day}+interval '8 second',${day}+interval '9 second',6,$8,now()+interval '30 minute','Giro lento favorece retirada')`,[quote,generation,conversation,question,mainId,product,owner,order]);
  await db.pool.query(`INSERT INTO agent.turns(id,environment,conversation_id,trigger_message_id,agent_version,context_hash,status,say_text)
    VALUES($1,'test',$2,$3,'v2','fixture','generated','Rascunho confidencial')`,[turn,conversation,question]);
  await db.pool.query(`INSERT INTO core.messages(environment,conversation_id,chatwoot_conversation_id,chatwoot_message_id,
    sender_type,message_type,is_private,content,sent_at,echo_id)
    VALUES('test',$1,44001,6,'agent_bot',1,false,'Fecho por 80 no Pix',${day}+interval '9 second',$2)`,[conversation,'turn:'+turn]);
},240000);
afterAll(async()=>{await app?.close();await appPool?.end();if(db)await stopPostgres(db);});

it('a tela nova lê uma consulta da 0296 e informa os campos ainda sem instrumentação',()=>{
  expect(history0296.status).toBe(200);
  expect(history0296.data.turns).toEqual(expect.arrayContaining([expect.objectContaining({
    id:question,consulta:expect.objectContaining({decisao:'manter',proposta_centavos:8000,tabela_unitaria_centavos:11000,
      ficha:null,justificativa:null,lida_em:null,decidida_em:null,tempo_milly_ms:null})
  })]));
});

it('duas sessões reais de dono leem o turno e o preço confirmado sem inferir respostas soltas',async()=>{
  for(const [prefix,headers] of [[panel,{cookie:ownerCookie}],[mobile,{authorization:ownerToken}]] as const){
    const r=await app.inject({url:prefix+'/'+conversation+'/milly',headers});
    expect(r.statusCode,r.body).toBe(200);expect(r.headers['cache-control']).toContain('no-store');
    const data=r.json();
    expect(data.next).toBe(null);expect(data.turns.map((v:{numero:number})=>v.numero)).toEqual([1,2,3]);
    expect(data.turns[0]).toMatchObject({id:greeting,consulta:null,atendente:null,tempo_resposta_ms:null});
    expect(data.turns[1]).toMatchObject({id:question,atendente:{texto:'Fecho por 80 no Pix'},tempo_resposta_ms:6000,
      consulta:{estado:'consumed',decisao:'aceitar',tempo_milly_ms:4000,proposta_centavos:8000,tabela_unitaria_centavos:11000,
        aval_centavos:8000,justificativa:'Giro lento favorece retirada',ficha:{disponivel:100},pedido:{id:order,total_centavos:8000,itens:[{quantidade:1,unitario_centavos:8000}]}}});
    expect(data.turns[2]).toMatchObject({consulta:null,pedido:{id:order,total_centavos:8000}});
    expect(r.body).not.toMatch(/Rascunho confidencial|Nota que não é pública|outro assunto/);
    const semFechadas=await app.inject({url:prefix+'?filter=milly',headers});
    expect(semFechadas.json().rows).toHaveLength(0);
    const fechadas=await app.inject({url:prefix+'?filter=milly&closed=true',headers});
    expect(fechadas.statusCode,fechadas.body).toBe(200);expect(fechadas.json().rows.map((a:{id:string})=>a.id)).toEqual([conversation]);
    expect((await app.inject({url:prefix+'/'+foreign+'/milly',headers})).statusCode).toBe(404);
  }
});
it('reserva o filtro e o histórico ao dono humano e mantém a conversa comum sem a ficha',async()=>{
  const variants=[[panel,{cookie:adminCookie}],[mobile,{authorization:adminToken}],
    [panel,{authorization:'Bearer emergency-fixture'}]] as const;
  for(const [prefix,headers] of variants){
    for(const suffix of ['?filter=milly','/'+conversation+'/milly']){
      expect((await app.inject({url:prefix+suffix,headers})).statusCode).toBe(403);
    }
  }
  for(const prefix of [panel,mobile]){
    expect((await app.inject({url:prefix+'/'+conversation+'/milly'})).statusCode).toBe(401);
  }
  const chat=await app.inject({url:mobile+'/'+conversation+'/messages',headers:{authorization:adminToken}});
  expect(chat.statusCode,chat.body).toBe(200);
  expect(chat.body).not.toMatch(/custo_unitario_centavos|tempo_milly_ms|decidida_em|Rascunho confidencial|Giro lento favorece retirada/);
});
it('pagina inclusive falas durante o mesmo milissegundo, sem lacunas nem numeração relativa',async()=>{
  await db.pool.query(`INSERT INTO core.messages(environment,conversation_id,chatwoot_conversation_id,chatwoot_message_id,sender_type,
    message_type,is_private,content,sent_at) SELECT 'test',$1,44003,45000+n,'contact',0,false,'Mensagem '||n,
    ${day}+n*interval '1 microsecond' FROM generate_series(1,32) n`,[plain]);
  const url=panel+'/'+plain+'/milly',headers={cookie:ownerCookie};
  const current=(await app.inject({url,headers})).json();
  expect(current.turns).toHaveLength(30);expect(current.turns[0].numero).toBe(3);
  const previous=(await app.inject({url:url+'?'+new URLSearchParams({at:current.next.at,before:current.next.id}),headers})).json();
  expect(previous.turns.map((t:{numero:number})=>t.numero)).toEqual([1,2]);expect(previous.next).toBe(null);
});

it('distingue pausa, prazo vencido e consulta legada; ACK privado nunca aparece como envio público',async()=>{
  const chat=randomUUID(),trigger=randomUUID(),id=randomUUID(),url=panel+'/'+chat+'/milly';
  const headers={cookie:ownerCookie};
  await db.pool.query(`INSERT INTO core.conversations(id,environment,chatwoot_conversation_id,chatwoot_account_id,contact_id,current_status,started_at)
    VALUES($1,'test',44004,44,$2,'open',now())`,[chat,contact]);
  await db.pool.query(`INSERT INTO core.messages(id,environment,conversation_id,chatwoot_conversation_id,chatwoot_message_id,
    sender_type,message_type,content,sent_at) VALUES($1,'test',$2,44004,46001,'contact',0,'Condição especial?',${day})`,[trigger,chat]);
  await db.pool.query(`INSERT INTO ops.milly_consultas
    (id,environment,generation,conversation_id,trigger_message_id,unit_id,product_id,quantity,payment_method,fulfillment_mode,
     offered_total_cents,catalog_unit_cents,freight_cents,state) VALUES($1,'test',$2,$3,$4,$5,$6,1,'pix','pickup',8000,11000,0,'pending')`,
    [id,generation,chat,trigger,mainId,product]);
  await db.pool.query(`INSERT INTO ops.outbound_messages(environment,conversation_id,trigger_message_id,chatwoot_conversation_id,
    provider_message_id,kind,body,body_sha256,status,sent_at)
    VALUES('test',$1,$2,44004,46002,'agent_text','Recebemos sua mensagem','fixture','sent_api_ack',${day}+interval '2 second')`,[chat,trigger]);
  const row=async()=>(await app.inject({url,headers})).json().turns[0];
  expect(await row()).toMatchObject({atendente:{texto:'Recebemos sua mensagem'},tempo_resposta_ms:2000,
    consulta:{id,estado:'paused',ficha:null,lida_em:null,decidida_em:null,tempo_milly_ms:null,justificativa:null,pedido:null}});
  await db.pool.query("UPDATE ops.milly_consulta_config SET enabled=true WHERE environment='test'");
  await db.pool.query("UPDATE ops.milly_consultas SET request_deadline=now()-interval '1 second' WHERE id=$1",[id]);
  await db.pool.query(`INSERT INTO core.messages(environment,conversation_id,chatwoot_conversation_id,chatwoot_message_id,sender_type,
    message_type,is_private,content,sent_at) VALUES('test',$1,44004,46002,'user',1,true,'Nota privada',now())`,[chat]);
  expect(await row()).toMatchObject({atendente:null,tempo_resposta_ms:null,consulta:{estado:'expired'}});
});
