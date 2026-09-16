import { afterAll,beforeAll,beforeEach,describe,expect,it } from 'vitest';
import { startPostgres,stopPostgres,type IntegrationDb } from './helpers/postgres.js';
import { botMayProcessTrigger,lockBotConversation,syncHumanIntervention } from '../../src/atendente-v2/conversation-control.js';
import type { HumanHandoffContext } from '../../src/atendente-v2/human-handoff.js';

let db:IntegrationDb;
let context:HumanHandoffContext;
let nativeId=70000;
let execute:typeof import('../../src/atendente-v2/tools.js').executeTool;
let prepare:typeof import('../../src/atendente-v2/outbound-control.js').prepareControlledOutbound;
let stale:typeof import('../../src/atendente-v2/outbound-worker.js').supersedeStaleAgentOutbound;
let change:typeof import('../../src/admin/painel/bot-conversation-control.js').changeBotConversationControl;
const args={ motivo:'cliente_pediu',resumo:'Cliente pediu atendimento humano.' };
beforeAll(async () => {
  Object.assign(process.env,{ NODE_ENV:'test',FAREJADOR_ENV:'test',BOT_OUTBOX:'true',
    DATABASE_URL:'postgresql://test:test@127.0.0.1:5432/farejador_test',
    CHATWOOT_HMAC_SECRET:'test-secret',ADMIN_AUTH_TOKEN:'test-token' });
  ({ executeTool:execute }=await import('../../src/atendente-v2/tools.js'));
  ({ prepareControlledOutbound:prepare }=await import('../../src/atendente-v2/outbound-control.js'));
  ({ supersedeStaleAgentOutbound:stale }=await import('../../src/atendente-v2/outbound-worker.js'));
  ({ changeBotConversationControl:change }=await import('../../src/admin/painel/bot-conversation-control.js'));
  db=await startPostgres();
},180000);
afterAll(async () => { if(db) await stopPostgres(db); });

async function message(conversationId:string,sender='contact',attributes={}) {
  const result=await db.pool.query(`INSERT INTO core.messages
    (environment,conversation_id,chatwoot_conversation_id,chatwoot_message_id,sender_type,
     message_type,is_private,content,content_attributes,sent_at)
    SELECT 'test',id,chatwoot_conversation_id,$2,$3,$4,false,'fixture',$5::jsonb,clock_timestamp()
    FROM core.conversations WHERE environment='test' AND id=$1 RETURNING id`,
  [conversationId,++nativeId,sender,sender==='contact'?0:1,JSON.stringify(attributes)]);
  return result.rows[0].id as string;
}
async function fixture():Promise<HumanHandoffContext> {
  const conv=(await db.pool.query(`INSERT INTO core.conversations
    (environment,chatwoot_conversation_id,chatwoot_account_id,current_status,started_at)
    VALUES ('test',$1,2,'open',now()) RETURNING id,chatwoot_conversation_id`,[++nativeId])).rows[0];
  const trigger=await message(conv.id);
  const job=(await db.pool.query(`INSERT INTO ops.atendente_jobs
    (environment,conversation_id,trigger_message_id,status) VALUES ('test',$1,$2,'processing')
    RETURNING id`,[conv.id,trigger])).rows[0];
  return { toolCallId:'handoff',input:{ environment:'test',conversationId:conv.id,
    chatwootConversationId:Number(conv.chatwoot_conversation_id),triggerMessageId:trigger,jobId:job.id,
    actions:[{ role:'assistant',content:null,tool_calls:[{ id:'handoff',type:'function',function:{
      name:'escalar_humano',arguments:JSON.stringify(args),
    } }] }],inputTokens:10,outputTokens:5,durationMs:100 } };
}
beforeEach(async () => { context=await fixture(); });
async function handoff(ctx=context) {
  const client=await db.pool.connect();
  try { return JSON.parse(await execute(client,'test',ctx.input.conversationId,'escalar_humano',args,ctx)); }
  finally { client.release(); }
}
async function queued(ctx=context) {
  return (await db.pool.query(`INSERT INTO ops.outbound_messages
    (environment,conversation_id,trigger_message_id,chatwoot_conversation_id,kind,body,body_sha256,status)
    VALUES ('test',$1,$2,$3,'agent_text','old','hash','pending') RETURNING *`,
  [ctx.input.conversationId,ctx.input.triggerMessageId,ctx.input.chatwootConversationId])).rows[0];
}
async function notice() {
  return (await db.pool.query(`SELECT * FROM ops.outbound_messages
    WHERE environment='test' AND conversation_id=$1 AND turn_id IS NOT NULL`,[context.input.conversationId])).rows[0];
}
async function mayProcess(trigger:string) {
  const client=await db.pool.connect();
  try { return await botMayProcessTrigger(client,'test',context.input.conversationId,trigger); }
  finally { client.release(); }
}
async function allowedToSend(row:Awaited<ReturnType<typeof notice>>) {
  const client=await db.pool.connect();
  try {
    await client.query('BEGIN');await lockBotConversation(client,'test',row.conversation_id);
    const allowed=await prepare(client,row);await client.query('COMMIT');return allowed;
  } catch(error) { await client.query('ROLLBACK');throw error; }
  finally { client.release(); }
}

describe('pedido de humano pela ferramenta',() => {
  it('pausa imediatamente, audita, cancela fila anterior e mantém só um aviso sem afetar outra conversa',async () => {
    const old=await queued(),other=await fixture(),otherOut=await queued(other);
    const later=await message(context.input.conversationId);
    await db.pool.query(`INSERT INTO ops.atendente_jobs(environment,conversation_id,trigger_message_id,status)
      VALUES ('test',$1,$2,'pending')`,[context.input.conversationId,later]);
    expect(await handoff()).toMatchObject({ ok:true,bot_pausado:true });
    expect(await mayProcess(later)).toBe(false);
    const row=await notice();
    const control=(await db.pool.query(`SELECT mode,version,updated_by FROM ops.conversation_bot_control
      WHERE environment='test' AND conversation_id=$1`,[context.input.conversationId])).rows[0];
    expect(control).toEqual({ mode:'human',version:1,updated_by:`agent:handoff:${row.id}` });
    expect((await db.pool.query(`SELECT action,actor FROM ops.conversation_bot_control_events
      WHERE conversation_id=$1`,[context.input.conversationId])).rows).toEqual([{action:'takeover',actor:control.updated_by}]);
    expect((await db.pool.query('SELECT status FROM ops.outbound_messages WHERE id=$1',[old.id])).rows[0].status).toBe('superseded');
    expect((await db.pool.query('SELECT status FROM ops.outbound_messages WHERE id=$1',[otherOut.id])).rows[0].status).toBe('pending');
    expect((await db.pool.query(`SELECT status FROM ops.atendente_jobs WHERE trigger_message_id=$1`,[later])).rows[0].status).toBe('superseded');
    expect((await db.pool.query(`SELECT status FROM ops.atendente_jobs WHERE id=$1`,[context.input.jobId])).rows[0].status).toBe('processing');
    expect(await handoff()).toMatchObject({status:'superseded'});
    expect((await db.pool.query(`SELECT count(*)::int AS count FROM ops.outbound_messages WHERE conversation_id=$1 AND turn_id IS NOT NULL`,[context.input.conversationId])).rows[0].count).toBe(1);
  });
  it('mensagem nova não cancela o aviso; só ele passa pela guarda mesmo em retry',async () => {
    await handoff();await message(context.input.conversationId);
    const client=await db.pool.connect();
    try { await stale(client,'test'); } finally { client.release(); }
    let row=await notice();expect(row.status).toBe('pending');
    await db.pool.query(`UPDATE ops.outbound_messages SET status='sending',attempts=1 WHERE id=$1`,[row.id]);
    row=await notice();expect(await allowedToSend(row)).toBe(true);
    await message(context.input.conversationId,'user',{farejador_echo_id:row.echo_id});
    expect(await allowedToSend(row)).toBe(true); // Eco do próprio bot não vira nova intervenção.
    await db.pool.query(`UPDATE ops.outbound_messages SET status='failed' WHERE id=$1`,[row.id]);
    const retryClient=await db.pool.connect();
    try { await stale(retryClient,'test'); } finally { retryClient.release(); }
    expect((await notice()).status).toBe('failed');
    await db.pool.query(`UPDATE ops.outbound_messages SET status='sending' WHERE id=$1`,[row.id]);
    expect(await allowedToSend(await notice())).toBe(true);
    await db.pool.query(`UPDATE ops.outbound_messages SET status='sent_api_ack' WHERE id=$1`,[row.id]);
    expect(await allowedToSend(await notice())).toBe(false);
  });
  it('retomada pelo robô cancela aviso pendente e libera somente mensagem nova',async () => {
    await handoff();const during=await message(context.input.conversationId);
    await change({conversationId:context.input.conversationId,action:'resume',expectedVersion:1,actor:'fixture'},db.pool);
    expect((await notice()).status).toBe('superseded');
    expect(await mayProcess(during)).toBe(false);
    expect(await mayProcess(await message(context.input.conversationId))).toBe(true);
  });
  it('mensagem real do atendente cancela o aviso pendente',async () => {
    await handoff();await message(context.input.conversationId,'user');
    const client=await db.pool.connect();
    try {
      await client.query('BEGIN');await lockBotConversation(client,'test',context.input.conversationId);
      expect((await syncHumanIntervention(client,'test',context.input.conversationId)).version).toBe(2);
      await client.query('COMMIT');
    } finally { client.release(); }
    expect((await notice()).status).toBe('superseded');
  });
  it('falha de gravação reverte aviso e pausa juntos, permitindo retry seguro',async () => {
    const client=await db.pool.connect();
    const realQuery=client.query.bind(client);
    const failing={query:async(sql:string,values?:unknown[]) => {
      if(sql.includes('INSERT INTO ops.conversation_bot_control_events')) throw new Error('fixture_failure');
      return realQuery(sql,values);
    }};
    try {
      const failed=JSON.parse(await execute(failing as never,'test',context.input.conversationId,'escalar_humano',args,context));
      expect(failed).toEqual({erro:'fixture_failure'});
      expect(await notice()).toBeUndefined();
      expect(await botMayProcessTrigger(client,'test',context.input.conversationId,context.input.triggerMessageId)).toBe(true);
    } finally { client.release(); }
    expect(await handoff()).toMatchObject({ok:true});
  });
  it('não anuncia sucesso sem contexto e não cruza ambientes',async () => {
    const client=await db.pool.connect();
    try {
      expect(JSON.parse(await execute(client,'test',context.input.conversationId,'escalar_humano',args)))
        .toEqual({erro:'human_handoff_requires_turn_context'});
      expect(JSON.parse(await execute(client,'prod',context.input.conversationId,'escalar_humano',args,context)))
        .toEqual({erro:'human_handoff_requires_turn_context'});
    } finally { client.release(); }
    expect(await notice()).toBeUndefined();
  });
});
