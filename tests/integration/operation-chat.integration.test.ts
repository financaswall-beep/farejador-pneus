import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import type {Pool} from 'pg';
import Fastify,{type FastifyInstance,type FastifyRequest} from 'fastify';
import {startPostgres,stopPostgres,type IntegrationDb} from './helpers/postgres.js';
import type {CaixaAuth} from '../../src/admin/caixa/queries.js';
import sharp from 'sharp';

vi.mock('../../src/atendente-v2/outbound-worker.js',async original=>({
  ...await original<typeof import('../../src/atendente-v2/outbound-worker.js')>(),pollBotOutbox:vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/atendente-v2/sender.js',()=>({sendAttachmentOnce:vi.fn().mockResolvedValue({chatwootMessageId:888888}),
  sendMessageOnce:vi.fn().mockResolvedValue({chatwootMessageId:888889}),resolveConversationOnce:vi.fn()}));
describe('conversas no app, banco real e nenhum envio externo',()=>{
  let db:IntegrationDb,app:FastifyInstance,defaultPool:Pool;
  let queries:typeof import('../../src/admin/caixa/chat-queries.js');
  let queue:typeof import('../../src/admin/caixa/chat-send.js').queueOperatorMessage;
  let cancel:typeof import('../../src/atendente-v2/conversation-control.js').cancelConversationBotQueue;
  const conversation=randomUUID(),foreign=randomUUID(),contact=randomUUID(),base='/api/caixa/chat/conversations';
  const headers={authorization:'local-owner'};
  beforeAll(async()=>{
    db=await startPostgres();
    Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:db.connectionString,DATABASE_SSL:'false',
      CHATWOOT_HMAC_SECRET:'test-secret',ADMIN_AUTH_TOKEN:'fixture-token',CHATWOOT_ACCOUNT_ID:'2',CHATWOOT_API_BASE_URL:'https://invalid.example/api/v1',
      CHATWOOT_API_TOKEN:'local-fixture',BOT_OUTBOX:'true',MATRIZ_CUSTOMER_IDENTITY:'true',AGENT_V2_CONVERSATION_IDS:'*'});
    vi.resetModules();
    ({pool:defaultPool}=await import('../../src/persistence/db.js'));
    queries=await import('../../src/admin/caixa/chat-queries.js');
    ({queueOperatorMessage:queue}=await import('../../src/admin/caixa/chat-send.js'));
    ({cancelConversationBotQueue:cancel}=await import('../../src/atendente-v2/conversation-control.js'));
    const {registerCaixaChatRoutes}=await import('../../src/admin/caixa/route-chat.js');
    app=Fastify();registerCaixaChatRoutes(app,async()=>{},async(req,reply)=>{
      if(!req.headers.authorization){await reply.code(401).send({error:'unauthorized'});return;}
      (req as FastifyRequest & {caixa:CaixaAuth}).caixa={personId:'fixture',collaboratorId:'fixture',displayName:'Teste',username:'fixture',job:'vendedor',
        panelRole:req.headers.authorization==='local-owner'?'owner':'admin',modules:{vendas:true,estoque:false,entregas:false,retiradas:false,financeiro:false}};
    });await app.ready();
    await db.pool.query(`INSERT INTO core.contacts(id,environment,chatwoot_contact_id,name) VALUES($1,'test',77001,'Marina Costa')`,[contact]);
    await db.pool.query(`INSERT INTO core.conversations(id,environment,chatwoot_conversation_id,chatwoot_account_id,contact_id,current_status,started_at)
      VALUES($1,'test',77001,2,$3,'open',now()),($2,'test',77002,999,$3,'open',now())`,[conversation,foreign,contact]);
    await db.pool.query(`INSERT INTO core.messages(environment,conversation_id,chatwoot_conversation_id,chatwoot_message_id,sender_type,message_type,content,sent_at)
      SELECT 'test',$1,77001,77000+n,'contact',0,'Mensagem '||n,now()-interval '1 day'+n*interval '1 second' FROM generate_series(1,510)n`,[conversation]);
  },180000);
  afterAll(async()=>{await app?.close();await defaultPool?.end();if(db)await stopPostgres(db);});
  it('protege sessão, permissão e conta Chatwoot',async()=>{
    expect((await app.inject({url:base})).statusCode).toBe(401);
    expect((await app.inject({url:base,headers:{authorization:'local-staff'}})).statusCode).toBe(403);
    expect((await app.inject({url:base+'/'+foreign,headers})).statusCode).toBe(404);
  });
  it('consulta fila e ficha da conversa com interesses e fotos sem gravar core',async()=>{
    await queries.listOperationConversations({filter:'all',search:'',channel:'',offset:0,closed:false},db.pool);
    const response=await app.inject({url:base+'?filter=all',headers});expect(response.statusCode,response.body).toBe(200);
    expect(response.json().rows.map((r:{id:string})=>r.id)).toEqual([conversation]);
    const detail=await app.inject({url:base+'/'+conversation,headers});expect(detail.statusCode,detail.body).toBe(200);
    expect(detail.json()).toMatchObject({id:conversation,name:'Marina Costa',mode:'auto',orders:[],photos:[]});
    const ficha=await app.inject({url:base+'/'+conversation+'/customer',headers});expect(ficha.statusCode,ficha.body).toBe(200);
    expect(ficha.json().customer.name).toBe('Marina Costa');
  });
  it('traz as últimas mensagens mesmo após 500 e pagina para trás sem repetir',async()=>{
    const recent=await queries.getOperationMessages(conversation,undefined,db.pool);
    expect(recent.messages.at(-1)?.content).toBe('Mensagem 510');expect(recent.messages).toHaveLength(60);
    const prior=await queries.getOperationMessages(conversation,recent.next!,db.pool);
    expect(prior.messages.at(-1)?.content).toBe('Mensagem 450');
    expect(new Set([...recent.messages,...prior.messages].map(m=>m.id)).size).toBe(120);
  });
  it('pausa o bot e enfileira uma única mensagem nas tentativas concorrentes',async()=>{
    const token=randomUUID(),input={conversationId:conversation,clientToken:token,content:'Resposta humana',actor:'caixa:fixture'};
    const results=await Promise.all([queue(input,db.pool),queue(input,db.pool)]);
    expect(results[0].id).toBe(results[1].id);expect(results.some(r=>r.replayed)).toBe(true);
    expect((await db.pool.query(`SELECT mode FROM ops.conversation_bot_control WHERE conversation_id=$1`,[conversation])).rows[0].mode).toBe('human');
    const stored=(await db.pool.query(`SELECT o.status,o.kind,m.actor FROM ops.outbound_messages o JOIN ops.operator_messages m ON m.outbound_id=o.id WHERE o.id=$1`,[results[0].id])).rows[0];
    expect(stored).toMatchObject({status:'pending',kind:'operator_text',actor:'caixa:fixture'});
    await expect(queue({...input,content:'Texto diferente'},db.pool)).rejects.toThrow('chat_idempotency_conflict');
    const client=await db.pool.connect();try{await client.query('BEGIN');await cancel(client,'test',conversation);await client.query('COMMIT');}finally{client.release();}
    expect((await db.pool.query(`SELECT status FROM ops.outbound_messages WHERE id=$1`,[results[0].id])).rows[0].status).toBe('pending');
    const recent=await queries.getOperationMessages(conversation,undefined,db.pool);
    expect(recent.outgoing).toEqual(expect.arrayContaining([expect.objectContaining({content:'Resposta humana',client_token:token})]));
  });
  it('recusa mídia inválida e não cria mensagem',async()=>{
    const response=await app.inject({method:'POST',url:base+'/'+conversation+'/messages',headers,
      payload:{client_token:randomUUID(),file:{mime:'audio/webm',base64:Buffer.from('arquivo inválido').toString('base64')}}});
    expect(response.statusCode,response.body).toBe(415);
    expect((await db.pool.query(`SELECT count(*)::int n FROM core.messages WHERE conversation_id=$1`,[conversation])).rows[0].n).toBe(510);
  });
  it('ecoa envio humano sem duplicar bolha e respeita o isolamento prod/test',async()=>{
    const input={conversationId:conversation,clientToken:randomUUID(),content:'Mensagem confirmada',actor:'caixa:fixture'};
    const result=await queue(input,db.pool);
    await db.pool.query(`UPDATE ops.outbound_messages SET provider_message_id=999999,status='sent_api_ack' WHERE id=$1`,[result.id]);
    await db.pool.query(`INSERT INTO core.messages(environment,conversation_id,chatwoot_conversation_id,chatwoot_message_id,sender_type,message_type,content,sent_at)
      VALUES('test',$1,77001,999999,'user',1,'Mensagem confirmada',now())`,[conversation]);
    const timeline=await queries.getOperationMessages(conversation,undefined,db.pool);
    expect(timeline.messages.filter(m=>m.client_token===input.clientToken)).toHaveLength(1);
    expect(timeline.outgoing.some(m=>m.client_token===input.clientToken)).toBe(false);
    await expect(queue({...input,conversationId:foreign,clientToken:randomUUID()},db.pool)).rejects.toThrow('bot_conversation_not_found');
  });
  it('repete falha definitiva uma vez e impede reenvio de resultado ambíguo',async()=>{
    const {retryOperatorMessage}=await import('../../src/admin/caixa/chat-send.js');
    const result=await queue({conversationId:conversation,clientToken:randomUUID(),content:'Tentar entrega',actor:'caixa:fixture'},db.pool);
    await db.pool.query(`UPDATE ops.outbound_messages SET status='dead_letter',last_error_kind='authorization' WHERE id=$1`,[result.id]);
    const retries=await Promise.all([retryOperatorMessage(conversation,result.id,'fixture',db.pool),retryOperatorMessage(conversation,result.id,'fixture',db.pool)]);
    expect(retries.map(r=>r.status)).toEqual(['pending','pending']);
    expect((await db.pool.query(`SELECT count(*)::int n FROM ops.outbound_message_events WHERE outbound_id=$1 AND reason='operator_retry'`,[result.id])).rows[0].n).toBe(1);
    await db.pool.query(`UPDATE ops.outbound_messages SET status='dead_letter',last_error_kind='ambiguous' WHERE id=$1`,[result.id]);
    const response=await app.inject({method:'POST',url:base+'/'+conversation+'/messages/'+result.id+'/retry',headers});
    expect(response.statusCode,response.body).toBe(409);
  });
  it('mantém envio de foto pendente até o ACK e não duplica com o dispatcher do bot',async()=>{
    const unit=(await db.pool.query(`INSERT INTO core.units(environment,slug,name) VALUES('test','main','Matriz') ON CONFLICT(environment,slug) DO UPDATE SET name=EXCLUDED.name RETURNING id`)).rows[0].id;
    const photo=(await db.pool.query(`INSERT INTO commerce.photo_requests(environment,unit_id,conversation_id,tire_size) VALUES('test',$1,77001,'90/90-12') RETURNING id`,[unit])).rows[0].id;
    const before=await queries.getOperationConversation(conversation,db.pool);expect(before.photos[0]).toMatchObject({id:photo,status:'pending'});
    const bytes=await sharp({create:{width:4,height:4,channels:3,background:'#123456'}}).jpeg().toBuffer();
    const token=randomUUID(),file={mime:'image/jpeg',base64:bytes.toString('base64')};
    const {parseOperatorMedia}=await import('../../src/admin/caixa/chat-media.js');
    await queue({conversationId:conversation,clientToken:token,photoRequestId:photo,actor:'fixture',content:'Foto do pneu',file:await parseOperatorMedia(file)},db.pool);
    const response=await app.inject({method:'POST',url:base+'/'+conversation+'/messages',headers,
      payload:{client_token:token,photo_request_id:photo,content:'Foto do pneu',file}});
    expect(response.statusCode,response.body).toBe(202);
    const row=(await db.pool.query(`SELECT * FROM ops.outbound_messages WHERE id=$1`,[response.json().id])).rows[0];
    expect(row.echo_id).toBe('photo:'+photo);
    expect((await queries.getOperationConversation(conversation,db.pool)).photos[0].status).toBe('answered');
    const {deliverOutboundRow,markPhotoRequestSent}=await import('../../src/atendente-v2/outbound-delivery.js');
    const {sendAttachmentOnce}=await import('../../src/atendente-v2/sender.js');
    const client=await db.pool.connect();try{
      await deliverOutboundRow(client,row);expect(sendAttachmentOnce).toHaveBeenCalledWith(77001,expect.objectContaining({contentType:'image/jpeg'}),'Foto do pneu','photo:'+photo);
      await markPhotoRequestSent(client,row);
      await db.pool.query(`UPDATE ops.conversation_bot_control SET mode='auto' WHERE conversation_id=$1`,[conversation]);
      const {enqueuePhotoAttachment}=await import('../../src/atendente-v2/outbox-accessory.js');
      expect(await enqueuePhotoAttachment(client,{environment:'test',chatwootConversationId:77001,photoRequestId:photo,caption:'Foto'})).toBe(false);
    }finally{client.release();}
    expect((await queries.getOperationConversation(conversation,db.pool)).photos[0].status).toBe('sent');
    // Retenção só remove a cópia quando o anexo está no histórico normalizado.
    await db.pool.query(`UPDATE ops.outbound_messages SET status='sent_api_ack',provider_message_id=888888,sent_at=now()-interval '8 days' WHERE id=$1`,[row.id]);
    expect((await db.pool.query(`SELECT ops.prune_operator_media() n`)).rows[0].n).toBe(0);
    const message=(await db.pool.query(`INSERT INTO core.messages(environment,conversation_id,chatwoot_conversation_id,chatwoot_message_id,sender_type,message_type,sent_at)
      VALUES('test',$1,77001,888888,'user',1,now()) RETURNING id`,[conversation])).rows[0].id;
    await db.pool.query(`INSERT INTO core.message_attachments(environment,message_id,conversation_id,chatwoot_attachment_id,file_type,data_url) VALUES('test',$1,$2,888888,'image','https://invalid.example/photo.jpg')`,[message,conversation]);
    expect((await db.pool.query(`SELECT ops.prune_operator_media() n`)).rows[0].n).toBe(1);
    expect((await db.pool.query(`SELECT bytes FROM ops.operator_messages WHERE outbound_id=$1`,[row.id])).rows[0].bytes).toBeNull();
  });
  it('preserva ordem de duas mensagens humanas e permite envio com o bot pausado',async()=>{
    await db.pool.query(`UPDATE ops.outbound_messages SET status='superseded' WHERE status IN ('pending','failed')`);
    const one=await queue({conversationId:conversation,clientToken:randomUUID(),actor:'fixture',content:'Primeira'},db.pool);
    const two=await queue({conversationId:conversation,clientToken:randomUUID(),actor:'fixture',content:'Segunda'},db.pool);
    const {pickOutboundMessage}=await import('../../src/atendente-v2/outbound-worker.js');
    const {prepareControlledOutbound}=await import('../../src/atendente-v2/outbound-control.js');
    const client=await db.pool.connect();try{
      const first=await pickOutboundMessage(client,'test','test-worker',[]);expect(first?.id).toBe(one.id);
      expect(await pickOutboundMessage(client,'test','other-worker',[])).toBeNull();
      expect(await prepareControlledOutbound(client,first!)).toBe(true);
      await db.pool.query(`UPDATE ops.outbound_messages SET status='sent_api_ack' WHERE id=$1`,[one.id]);
      expect((await pickOutboundMessage(client,'test','test-worker',[]))?.id).toBe(two.id);
    }finally{client.release();}
  });
});
