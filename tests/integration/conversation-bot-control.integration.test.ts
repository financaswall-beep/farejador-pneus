import { afterAll,beforeAll,beforeEach,describe,expect,it } from 'vitest';
import type { PoolClient } from 'pg';
import { applyMigrationFile,startPostgres,stopPostgres,type IntegrationDb } from './helpers/postgres';
import { botMayProcessTrigger,ensureBotControl,lockBotConversation,syncHumanIntervention } from '../../src/atendente-v2/conversation-control';

let db: IntegrationDb;
let conversationId: string;
let nativeId=30000;
let messageId=50000;
let change: typeof import('../../src/admin/painel/bot-conversation-control').changeBotConversationControl;
let prepare: typeof import('../../src/atendente-v2/outbound-control').prepareControlledOutbound;
beforeAll(async () => {
  Object.assign(process.env,{ NODE_ENV:'test',FAREJADOR_ENV:'test',
    DATABASE_URL:'postgresql://test:test@127.0.0.1:5432/farejador_test',
    CHATWOOT_HMAC_SECRET:'test-secret',ADMIN_AUTH_TOKEN:'test-token' });
  ({ changeBotConversationControl:change } = await import('../../src/admin/painel/bot-conversation-control'));
  ({ prepareControlledOutbound:prepare } = await import('../../src/atendente-v2/outbound-control'));
  db=await startPostgres();
});
afterAll(async () => { if (db) await stopPostgres(db); });
async function newConversation() {
  const r=await db.pool.query(`INSERT INTO core.conversations
    (environment,chatwoot_conversation_id,chatwoot_account_id,current_status,started_at)
    VALUES ('test',$1,2,'open',now()) RETURNING id`, [++nativeId]);
  return r.rows[0].id as string;
}
beforeEach(async () => { if (db) conversationId=await newConversation(); });
async function addMessage(sender='user',options:{ private?:boolean; type?:number; attributes?:object; ago?:number; sentAt?:string }={}) {
  const r=await db.pool.query(`INSERT INTO core.messages
    (environment,conversation_id,chatwoot_conversation_id,chatwoot_message_id,sender_type,message_type,is_private,content,content_attributes,sent_at)
    SELECT 'test',id,chatwoot_conversation_id,$2,$3,$4,$5,'fixture',$6::jsonb,
      COALESCE($8::timestamptz,clock_timestamp()-($7||' seconds')::interval)
      FROM core.conversations WHERE id=$1 RETURNING id,chatwoot_message_id`,
  [conversationId,++messageId,sender,options.type ?? (sender==='contact'?0:1),options.private ?? false,
    JSON.stringify(options.attributes ?? {}),String(options.ago ?? 0),options.sentAt ?? null]);
  return r.rows[0] as { id:string;chatwoot_message_id:string };
}
async function sync(client:PoolClient,id=conversationId) {
  await client.query('BEGIN');
  try {
    await lockBotConversation(client,'test',id);
    const state=await syncHumanIntervention(client,'test',id);
    await client.query('COMMIT');return state;
  } catch (error) { await client.query('ROLLBACK');throw error; }
}
async function queued(triggerId:string|null=null,echo=`echo:${conversationId}`,status='pending') {
  const r=await db.pool.query(`INSERT INTO ops.outbound_messages
    (environment,conversation_id,chatwoot_conversation_id,trigger_message_id,kind,body,body_sha256,status,echo_id,attempts)
    SELECT 'test',id,chatwoot_conversation_id,$2,'agent_text','fixture','hash',$3,$4,1
    FROM core.conversations WHERE id=$1 RETURNING *`,[conversationId,triggerId,status,echo]);
  return r.rows[0];
}
describe('handoff silencioso no PostgreSQL isolado',() => {
  it('pausa e cancela apenas a conversa com mensagem humana; reprocessar não duplica auditoria',async () => {
    const other=await newConversation();
    await queued();await addMessage();
    const client=await db.pool.connect();
    try {
      expect((await sync(client)).mode).toBe('human');
      expect((await sync(client,other)).mode).toBe('auto');
      expect((await sync(client)).version).toBe(1);
      expect((await db.pool.query(`SELECT status FROM ops.outbound_messages WHERE conversation_id=$1`,[conversationId])).rows[0].status).toBe('superseded');
      expect((await db.pool.query(`SELECT count(*) FROM ops.conversation_bot_control_events WHERE conversation_id=$1`,[conversationId])).rows[0].count).toBe('1');
    } finally { client.release(); }
  });
  it('ignora notas privadas, atividade e mensagens do agent_bot',async () => {
    await addMessage('user',{ private:true });await addMessage('user',{ type:2 });await addMessage('agent_bot');
    const client=await db.pool.connect();
    try { expect((await sync(client)).mode).toBe('auto'); } finally { client.release(); }
  });
  it('preserva microssegundos ao reprocessar a mesma intervenção e no limite da retomada',async () => {
    const times=(await db.pool.query(`SELECT
      (date_trunc('second',now())-interval '1 second'+interval '123400 microseconds')::text AS before,
      (date_trunc('second',now())-interval '1 second'+interval '123456 microseconds')::text AS boundary,
      (date_trunc('second',now())-interval '1 second'+interval '123499 microseconds')::text AS after`)).rows[0];
    await addMessage('user',{ sentAt:times.boundary });
    const client=await db.pool.connect();
    try {
      for (let i=0;i<3;i++) {
        const state=await sync(client);
        expect(state.version).toBe(1);
        expect(state.last_human_at).toBe(times.boundary);
      }
      await db.pool.query(`UPDATE ops.conversation_bot_control SET mode='auto',resumed_at=$2
        WHERE environment='test' AND conversation_id=$1`,[conversationId,times.boundary]);
      const older=await addMessage('contact',{ sentAt:times.before });
      const newer=await addMessage('contact',{ sentAt:times.after });
      expect(await botMayProcessTrigger(client,'test',conversationId,older.id)).toBe(false);
      expect(await botMayProcessTrigger(client,'test',conversationId,newer.id)).toBe(true);
    } finally { client.release(); }
  });
  it('não confunde mensagem própria com humano mesmo usando o mesmo usuário e webhook antes do ACK',async () => {
    await queued(null,'turn:fixture','sending');
    await addMessage('user',{ attributes:{ farejador_echo_id:'turn:fixture' } });
    const client=await db.pool.connect();
    try { expect((await sync(client)).mode).toBe('auto'); } finally { client.release(); }
  });
  it('reconhece o id confirmado mesmo se o Chatwoot omitir echo_id e atributos',async () => {
    const out=await queued(),message=await addMessage();
    await db.pool.query(`UPDATE ops.outbound_messages SET provider_message_id=$2,status='sent_api_ack' WHERE id=$1`,[out.id,message.chatwoot_message_id]);
    const client=await db.pool.connect();
    try { expect((await sync(client)).mode).toBe('auto'); } finally { client.release(); }
  });
  it('retoma explicitamente sem responder gatilhos antigos nem mensagem humana atrasada',async () => {
    const old=await addMessage('contact',{ ago:10 });
    const paused=await change({ conversationId,action:'takeover',expectedVersion:0,actor:'fixture' },db.pool);
    const client=await db.pool.connect();
    try {
      expect(await botMayProcessTrigger(client,'test',conversationId,old.id)).toBe(false);
      await change({ conversationId,action:'resume',expectedVersion:paused.version,actor:'fixture' },db.pool);
      await addMessage('user',{ ago:30 });
      expect(await botMayProcessTrigger(client,'test',conversationId,old.id)).toBe(false);
      const fresh=await addMessage('contact');
      expect(await botMayProcessTrigger(client,'test',conversationId,fresh.id)).toBe(true);
      const out=await queued(fresh.id,'fresh','sending');
      await client.query('BEGIN');
      await lockBotConversation(client,'test',conversationId);
      try { expect(await prepare(client,out)).toBe(true); }
      finally { await client.query('ROLLBACK'); }
    } finally { client.release(); }
  });
  it('não libera uma conversa por clique com versão desatualizada',async () => {
    await change({ conversationId,action:'takeover',expectedVersion:0,actor:'fixture' },db.pool);
    await expect(change({ conversationId,action:'resume',expectedVersion:0,actor:'fixture' },db.pool)).rejects.toThrow('bot_control_conflict');
  });
  it.each(['agent_text','survey_text','photo_text','photo_attachment'])('descarta %s já selecionado pela fila quando humano assume antes do HTTP',async kind => {
    const trigger=await addMessage('contact');
    const out=await queued(trigger.id,`queued:${conversationId}`,'sending');
    await db.pool.query(`UPDATE ops.outbound_messages SET kind=$2,body=$3 WHERE id=$1`,
      [out.id,kind,kind==='photo_attachment' ? JSON.stringify({ photo_request_id:conversationId,caption:'fixture' }) : 'fixture']);
    await change({ conversationId,action:'takeover',expectedVersion:0,actor:'fixture' },db.pool);
    const client=await db.pool.connect();
    try {
      await client.query('BEGIN');await lockBotConversation(client,'test',conversationId);
      expect(await prepare(client,{ ...out,kind })).toBe(false);
      await client.query('COMMIT');
      expect((await db.pool.query('SELECT status FROM ops.outbound_messages WHERE id=$1',[out.id])).rows[0].status).toBe('superseded');
    } finally { await client.query('ROLLBACK');client.release(); }
  });
  it('reaplicar a migration não retoma atendimento humano nem zera versão',async () => {
    const state=await change({ conversationId,action:'takeover',expectedVersion:0,actor:'fixture' },db.pool);
    await applyMigrationFile(db.pool,'0216_conversation_bot_control.sql');
    const actual=(await db.pool.query(`SELECT mode,version FROM ops.conversation_bot_control
      WHERE environment='test' AND conversation_id=$1`,[conversationId])).rows[0];
    expect(actual).toEqual(state);
  });
  it('nega cruzar ambiente e preserva o histórico append-only',async () => {
    const client=await db.pool.connect();
    try {
      await expect(ensureBotControl(client,'prod',conversationId)).rejects.toThrow('bot_conversation_not_found');
      await expect(db.pool.query(`INSERT INTO ops.conversation_bot_control(environment,conversation_id) VALUES ('prod',$1)`,[conversationId])).rejects.toMatchObject({ code:'23503' });
      await change({ conversationId,action:'takeover',expectedVersion:0,actor:'fixture' },db.pool);
      await expect(db.pool.query(`UPDATE ops.conversation_bot_control_events SET actor='changed' WHERE conversation_id=$1`,[conversationId])).rejects.toMatchObject({ code:'55000' });
    } finally { client.release(); }
  });
  it('serializa takeover com envio já iniciado até finalizar o ACK',async () => {
    const client=await db.pool.connect();
    let pending:ReturnType<typeof change>|undefined;
    try {
      await ensureBotControl(client,'test',conversationId);
      await client.query('BEGIN');
      await lockBotConversation(client,'test',conversationId);
      pending=change({ conversationId,action:'takeover',expectedVersion:0,actor:'fixture' },db.pool);
      // O lock impede a confirmação concorrente até o sender terminar sua operação.
      const probe=await db.pool.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',
        [`bot-control:test:${conversationId}`]);
      expect(probe.rows[0].acquired).toBe(false);
      await client.query('COMMIT');
      expect((await pending).mode).toBe('human');
    } finally {
      await client.query('ROLLBACK').catch(()=>undefined);
      client.release();await pending;
    }
  });
});
