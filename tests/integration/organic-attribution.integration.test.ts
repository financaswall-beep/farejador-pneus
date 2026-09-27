import { beforeAll,afterAll,it,expect,vi } from 'vitest';
import { startPostgres,stopPostgres,type IntegrationDb } from './helpers/postgres.js';
import { organicAttributionReport } from '../../src/marketing/organic/report.js';
import { reconcileOrganicOrders } from '../../src/marketing/organic/orders.js';
import type {PoolClient} from 'pg';
import {randomUUID} from 'node:crypto';
let db:IntegrationDb;
beforeAll(async()=>{db=await startPostgres();},180000);
afterAll(async()=>{if(db)await stopPostgres(db);});
it('aplica toda a migration e consulta relatório vazio sem afetar pedidos',async()=>{
  const report=await organicAttributionReport(db.pool,'test','instagram','200','300',new Date().toISOString(),'7d');
  expect(report).toMatchObject({status:'ready',sales:0,conversations:0,confirmed_orders:0});
  await reconcileOrganicOrders(db.pool as unknown as PoolClient,'test');
});
it('novas tabelas ficam com RLS e sem acesso do portal parceiro',async()=>{
  const result=await db.pool.query(`SELECT c.relname,c.relrowsecurity,has_table_privilege('farejador_partner_app',c.oid,'SELECT') readable
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('ops','analytics') AND (c.relname LIKE 'organic_%' OR c.relname IN ('stock_interests','audio_transcriptions','audio_transcription_jobs')) AND c.relkind='r'`);
  expect(result.rows.length).toBe(9);
  for(const row of result.rows)expect(row).toMatchObject({relrowsecurity:true,readable:false});
});
it('vincula por identidade nativa, mantém pedido antigo fora e recalcula ao cancelar',async()=>{
  Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:'postgres://unused',CHATWOOT_HMAC_SECRET:'fake',ADMIN_AUTH_TOKEN:'fake',ORGANIC_ATTRIBUTION_ENABLED:'true',CHATWOOT_ACCOUNT_ID:'2',BOT_AUDIO_ENABLED:'true',BOT_AUDIO_MODEL:'gpt-transcribe',OPENAI_API_KEY:'fake',BOT_AUDIO_ALLOWED_HOSTS:'media.example'});
  const {bindOrganicSource}=await import('../../src/marketing/organic/inbound.js');
  const q=db.pool;
  const contact=(await q.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name) VALUES('test',90001,'Teste') RETURNING id`)).rows[0].id;
  const conv=(await q.query(`INSERT INTO core.conversations(environment,chatwoot_conversation_id,chatwoot_account_id,chatwoot_inbox_id,contact_id,current_status,started_at)
    VALUES('test',90001,2,39,$1,'open',now()) RETURNING id`,[contact])).rows[0].id;
  const prodConv=(await q.query(`INSERT INTO core.conversations(environment,chatwoot_conversation_id,chatwoot_account_id,current_status,started_at)
    VALUES('prod',90002,2,'open',now()) RETURNING id`)).rows[0].id;
  await q.query(`SELECT * FROM ops.ensure_monthly_partitions(2)`);
  const msg=(await q.query(`INSERT INTO core.messages(environment,chatwoot_message_id,conversation_id,chatwoot_conversation_id,sender_type,message_type,content,sent_at,native_message_id)
    VALUES('test',99001,$1,90001,'contact',0,'Sou de Caxias',now()-interval '10 minutes','incoming-exact') RETURNING id,sent_at`,[conv])).rows[0];
  const raw=(await q.query(`INSERT INTO raw.meta_messaging_events(environment,payload_sha256,signature,object_type,payload)
    VALUES('test',$1,'fake','instagram','{}') RETURNING id`,['a'.repeat(64)])).rows[0].id;
  async function outreach(id:string,recipient:string) {
    const c=(await q.query(`INSERT INTO core.meta_comments(environment,platform,account_id,comment_id,post_id,author_id,body,revision,occurred_at,last_event_at,raw_event_id)
      VALUES('test','instagram','200',$1,'300',$2,'Tem 90/90-12?','r1',now()-interval '12 minutes',now(),$3) RETURNING id`,[id,recipient,raw])).rows[0].id;
    const d=(await q.query(`INSERT INTO analytics.meta_comment_decisions(environment,comment_id,revision,action,comment_snapshot,sentiment,reply_text,reason,extractor_version,confidence_level,source_reference,model)
      VALUES('test',$1,'r1','reply','Tem 90/90-12?','neutral','Olá','Consulta','test','high','fixture','fake') RETURNING id`,[c])).rows[0].id;
    return (await q.query(`INSERT INTO ops.organic_outreach(environment,comment_id,decision_id,platform,account_id,recipient_id,provider_message_id,body,status,sent_at)
      VALUES('test',$1,$2,'instagram','200',$3,$4,'De onde você está falando, meu amigo?','sent',now()-interval '11 minutes') RETURNING id`,[c,d,recipient,'out-'+id])).rows[0].id;
  }
  const out=await outreach('301','55');
  const input={platform:'instagram',account:'200',sender:'55',conversationId:conv,messageId:msg.id,at:new Date(msg.sent_at)};
  await bindOrganicSource(q as any,'test',{...input,sender:'other'});
  expect((await q.query('SELECT * FROM analytics.organic_conversation_sources')).rowCount).toBe(0);
  await expect(bindOrganicSource(q as any,'test',{...input,conversationId:prodConv})).rejects.toThrow();
  await bindOrganicSource(q as any,'test',input);
  await bindOrganicSource(q as any,'test',input);
  expect((await q.query('SELECT * FROM analytics.organic_conversation_sources')).rowCount).toBe(1);
  const old=(await q.query(`INSERT INTO commerce.orders(environment,contact_id,source_conversation_id,total_amount,status,fulfillment_mode,source,created_at)
    VALUES('test',$1,$2,89,'open','pickup','chatwoot_com_bot',now()-interval '1 day') RETURNING id`,[contact,conv])).rows[0].id;
  const order=(await q.query(`INSERT INTO commerce.orders(environment,contact_id,source_conversation_id,total_amount,status,fulfillment_mode,source,customer_name)
    VALUES('test',$1,$2,89,'open','pickup','chatwoot_com_bot','Teste') RETURNING id`,[contact,conv])).rows[0].id;
  await reconcileOrganicOrders(q as any,'test');await reconcileOrganicOrders(q as any,'test');
  expect((await q.query('SELECT order_id FROM analytics.organic_order_sources')).rows).toEqual([{order_id:order}]);
  const published=new Date(Date.now()-3600000).toISOString();
  expect(await organicAttributionReport(q,'test','instagram','200','300',published,'7d')).toMatchObject({sales:0,confirmed_orders:1,conversations:1});
  await q.query(`UPDATE commerce.orders SET status='confirmed',retrieved_at=now() WHERE id=$1`,[order]);
  expect(await organicAttributionReport(q,'test','instagram','200','300',published,'7d')).toMatchObject({sales:1,revenue:89,confirmed_orders:1});
  await q.query(`UPDATE commerce.orders SET status='cancelled',updated_at=now() WHERE id=$1`,[order]);
  expect(await organicAttributionReport(q,'test','instagram','200','300',published,'7d')).toMatchObject({sales:0,revenue:0,confirmed_orders:0});
  await expect(q.query(`UPDATE analytics.organic_conversation_sources SET first_reply_at=now() WHERE outreach_id=$1`,[out])).rejects.toThrow(/imutavel/);
  // Outra abordagem torna a associação ambígua; não escolhe um post por adivinhação.
  await outreach('302','66');await outreach('303','66');
  await bindOrganicSource(q as any,'test',{...input,sender:'66',messageId:randomUUID()});
  expect((await q.query('SELECT * FROM analytics.organic_conversation_sources')).rowCount).toBe(1);
  expect(old).not.toBe(order);
});

it('reconcilia mensagens comuns uma vez, sem prender a fila antes dos próximos leads',async()=>{
  const {reconcileOrganicInbound}=await import('../../src/marketing/organic/inbound.js');
  const q=db.pool,conv=(await q.query(`SELECT id FROM core.conversations WHERE environment='test' AND chatwoot_conversation_id=90001`)).rows[0].id;
  const raw=(await q.query(`SELECT id FROM raw.meta_messaging_events WHERE environment='test' LIMIT 1`)).rows[0].id;
  await q.query(`INSERT INTO ops.organic_controls(environment,platform,verified_inbox_id,verified_at,updated_by)
    VALUES('test','instagram',39,now(),'test')`);
  await q.query(`INSERT INTO core.messages(environment,chatwoot_message_id,conversation_id,chatwoot_conversation_id,sender_type,message_type,content,sent_at,native_message_id)
    VALUES('test',99002,$1,90001,'contact',0,'Oi',now(),'ordinary-mid')`,[conv]);
  await q.query(`INSERT INTO ops.organic_inbound(environment,platform,account_id,sender_id,provider_message_id,occurred_at,raw_event_id)
    VALUES('test','instagram','200','999','ordinary-mid',now(),$1)`,[raw]);
  await reconcileOrganicInbound(q as any,'test');
  const before=(await q.query(`SELECT reconciled_at,conversation_id FROM ops.organic_inbound WHERE provider_message_id='ordinary-mid'`)).rows[0];
  expect(before.conversation_id).toBe(conv);expect(before.reconciled_at).toBeInstanceOf(Date);
  await reconcileOrganicInbound(q as any,'test');
  expect((await q.query(`SELECT reconciled_at FROM ops.organic_inbound WHERE provider_message_id='ordinary-mid'`)).rows[0].reconciled_at).toEqual(before.reconciled_at);
});

it('transcreve uma vez fora de core, respeita confiança e registra consentimento sem inventar autorização',async()=>{
  const {prepareConversationAudio,audioNeedsConfirmation}=await import('../../src/atendente-v2/audio-transcription.js');
  const {registerStockInterest}=await import('../../src/atendente-v2/stock-interest.js');
  const {loadHistory}=await import('../../src/atendente-v2/history.js');
  const q=db.pool,conv=(await q.query(`SELECT id FROM core.conversations WHERE environment='test' AND chatwoot_conversation_id=90001`)).rows[0].id;
  const msg=(await q.query(`INSERT INTO core.messages(environment,chatwoot_message_id,conversation_id,chatwoot_conversation_id,sender_type,message_type,content,sent_at)
    VALUES('test',99003,$1,90001,'contact',0,NULL,now()) RETURNING id`,[conv])).rows[0].id;
  const attachment=(await q.query(`INSERT INTO core.message_attachments(environment,chatwoot_attachment_id,message_id,conversation_id,file_type,data_url)
    VALUES('test',99003,$1,$2,'audio','https://media.example/test.ogg') RETURNING id`,[msg,conv])).rows[0].id;
  const fetcher=vi.fn(async(input:any,options:any)=>{
    if(String(input).startsWith('https://media.example'))return new Response(Buffer.from('OggS'+'a'.repeat(32)));
    expect(options.body.get('model')).toBe('gpt-transcribe');
    expect(options.body.getAll('languages[]')).toEqual(['pt']);
    expect(options.body.has('include[]')).toBe(false);
    return Response.json({text:'Quero dois pneus.',usage:{type:'duration',seconds:4}});
  });
  vi.stubGlobal('fetch',fetcher);
  try {
    await prepareConversationAudio(q as any,'test',conv,{jobId:randomUUID(),triggerMessageId:msg} as any);
    await prepareConversationAudio(q as any,'test',conv);
    expect(fetcher).toHaveBeenCalledTimes(2); // um download e uma transcrição, nenhum reenvio
    expect((await q.query(`SELECT content FROM core.messages WHERE id=$1`,[msg])).rows[0].content).toBeNull();
    const transcript=(await q.query(`SELECT * FROM analytics.audio_transcriptions WHERE attachment_id=$1`,[attachment])).rows[0];
    expect(transcript).toMatchObject({transcript:'Quero dois pneus.',source:'llm',truth_type:'inferred',confidence_level:'low',
      model:'gpt-transcribe',extractor_version:'audio-v2'});
    expect((await q.query(`SELECT model,estimated_usd,input_tokens FROM ops.bot_model_usage WHERE trigger_message_id=$1`,[msg])).rows)
      .toEqual([{model:'gpt-transcribe',estimated_usd:null,input_tokens:null}]);
    expect(await audioNeedsConfirmation(q as any,'test',conv)).toBe(true);
    const history=await loadHistory(q as any,conv,{includeAudio:true});
    expect(history.some(m=>m.content?.includes('Quero dois pneus.'))).toBe(true);
    expect(history.some(m=>m.content?.includes('certeza não informada pelo transcritor'))).toBe(true);
    expect(history.some(m=>m.content?.includes('confiança low'))).toBe(false);
    await expect(q.query(`UPDATE analytics.audio_transcriptions SET transcript='Outro' WHERE id=$1`,[transcript.id])).rejects.toThrow(/imutavel/);
  } finally {vi.unstubAllGlobals();}
  const args={acao:'registrar',medida:'90/90-12',condicao:'meia_vida',telefone:'21988887777',consentimento:'Pode me avisar no WhatsApp 21 98888-7777'};
  expect(await registerStockInterest(q as any,'test',conv,args)).toMatchObject({erro:'autorizacao_nao_confirmada'});
  await q.query(`INSERT INTO core.messages(environment,chatwoot_message_id,conversation_id,chatwoot_conversation_id,sender_type,message_type,content,sent_at)
    VALUES('test',99004,$1,90001,'contact',0,$2,now())`,[conv,args.consentimento]);
  expect(await registerStockInterest(q as any,'test',conv,args)).toMatchObject({registrado:true});
  expect(await registerStockInterest(q as any,'test',conv,args)).toMatchObject({registrado:true});
  expect((await q.query(`SELECT * FROM ops.stock_interests`)).rowCount).toBe(1);
  await q.query(`INSERT INTO core.messages(environment,chatwoot_message_id,conversation_id,chatwoot_conversation_id,sender_type,message_type,content,sent_at)
    VALUES('test',99005,$1,90001,'contact',0,'Não me avise mais',now())`,[conv]);
  expect(await registerStockInterest(q as any,'test',conv,{...args,acao:'cancelar',consentimento:'Não me avise mais'})).toMatchObject({cancelado:true});
  expect(await registerStockInterest(q as any,'test',conv,args)).toMatchObject({erro:'novo_consentimento_necessario'});
});
