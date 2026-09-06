import { afterAll,afterEach,beforeAll,beforeEach,describe,expect,it } from 'vitest';
import type { Pool,PoolClient } from 'pg';
import { startPostgres,stopPostgres,type IntegrationDb } from './helpers/postgres';

let db:IntegrationDb,client:PoolClient,queryPool:Pool;
let nativeId=80000,messageId=90000;
let campainha:typeof import('../../src/admin/painel/queries-bot').getBotCampainha;
let humanos:typeof import('../../src/admin/painel/bot-conversation-control').listHumanControlledConversations;
beforeAll(async()=>{
  db=await startPostgres();
  // As migrations só preparam o mês atual/futuro. Fixtures antigas precisam
  // das partições históricas no banco efêmero (não é mudança em produção).
  await db.pool.query(`DO $partition$
    DECLARE v_month date; v_offset integer;
    BEGIN
      FOR v_offset IN 0..3 LOOP
        v_month := (date_trunc('month',now())-make_interval(months=>v_offset))::date;
        EXECUTE format('CREATE TABLE IF NOT EXISTS core.%I PARTITION OF core.messages FOR VALUES FROM (%L) TO (%L)',
          'messages_'||to_char(v_month,'YYYY_MM'),v_month,(v_month+interval '1 month')::date);
      END LOOP;
    END $partition$;`);
  Object.assign(process.env,{ NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:db.connectionString,
    CHATWOOT_HMAC_SECRET:'fixture',ADMIN_AUTH_TOKEN:'fixture' });
  ({getBotCampainha:campainha}=await import('../../src/admin/painel/queries-bot'));
  ({listHumanControlledConversations:humanos}=await import('../../src/admin/painel/bot-conversation-control'));
});
beforeEach(async()=>{ client=await db.pool.connect();await client.query('BEGIN');queryPool=client as unknown as Pool; });
afterEach(async()=>{ if(client) { await client.query('ROLLBACK');client.release(); } });
afterAll(async()=>{ if(db) await stopPostgres(db); });

async function conversation(status='open',environment='test') {
  return (await client.query(`INSERT INTO core.conversations
    (environment,chatwoot_conversation_id,chatwoot_account_id,current_status,started_at)
    VALUES ($1,$2,2,$3,now()-interval '90 days') RETURNING id`,[environment,++nativeId,status])).rows[0].id as string;
}
async function message(id:string,ago:string,options:{ sender?:string;private?:boolean;type?:number;status?:string;environment?:string }={}) {
  return (await client.query(`INSERT INTO core.messages
    (environment,conversation_id,chatwoot_conversation_id,chatwoot_message_id,sender_type,message_type,is_private,content,sent_at,status)
    SELECT $2,id,chatwoot_conversation_id,$3,$4,$5,$6,'fixture',now()-$7::interval,$8
    FROM core.conversations WHERE id=$1 RETURNING id,chatwoot_message_id`,
  [id,options.environment??'test',++messageId,options.sender??'contact',options.type??(options.sender==='user'?1:0),
    options.private??false,ago,options.status??null])).rows[0] as {id:string;chatwoot_message_id:string};
}
async function turn(id:string,trigger:string,status:string,providerId:string|null=null) {
  await client.query(`INSERT INTO agent.turns
    (environment,conversation_id,trigger_message_id,agent_version,context_hash,status,chatwoot_message_id)
    VALUES ('test',$1,$2,'v2','fixture',$3,$4)`,[id,trigger,status,providerId]);
}
async function escalation(id:string,ago:string,value=true) {
  await client.query(`INSERT INTO analytics.conversation_facts
    (environment,conversation_id,fact_key,fact_value,truth_type,source,extractor_version,created_at)
    VALUES ('test',$1,'escalou',$2::jsonb,'observed','integration_test','attention_period',now()-$3::interval)`,[id,JSON.stringify(value),ago]);
}
async function control(id:string,mode='human',resumedAgo:string|null=null) {
  await client.query(`INSERT INTO ops.conversation_bot_control(environment,conversation_id,mode,updated_at,resumed_at)
    VALUES ('test',$1,$2,now()-interval '45 days',CASE WHEN $3::text IS NULL THEN NULL ELSE now()-$3::interval END)`,[id,mode,resumedAgo]);
}

describe('fila de atenção sem vencimento automático',()=>{
  it('mantém pendências de 2, 7, 15, 30 e 45 dias pela data real, não pela ingestão',async()=>{
    const ids=[];
    for(const dias of [2,7,15,30,45]) { const id=await conversation();ids.push(id);await message(id,`${dias} days`); }
    const data=await campainha('test',queryPool);
    expect(data.mudas.map(row=>row.conversation_id)).toEqual(ids.reverse());
    expect(data.mudas[0]).toMatchObject({ minutos:45*1440,preview:'fixture' });
    expect(Number.isFinite(new Date(data.mudas[0]!.quando).getTime())).toBe(true);
  });
  it('não trunca esperando, encaminhados ou humanos nos antigos limites 20/10/200',async()=>{
    const rows=(await client.query(`INSERT INTO core.conversations
      (environment,chatwoot_conversation_id,chatwoot_account_id,current_status,started_at)
      SELECT 'test',100000+n,2,'open',now()-interval '45 days' FROM generate_series(1,201) n RETURNING id,chatwoot_conversation_id`)).rows;
    const ids=rows.map(row=>row.id);
    await client.query(`INSERT INTO core.messages
      (environment,conversation_id,chatwoot_conversation_id,chatwoot_message_id,sender_type,message_type,is_private,content,sent_at)
      SELECT 'test',id,chatwoot_conversation_id,chatwoot_conversation_id,'contact',0,false,'fixture',now()-interval '45 days'
      FROM core.conversations WHERE id=ANY($1::uuid[])`,[ids]);
    await client.query(`INSERT INTO ops.conversation_bot_control(environment,conversation_id,mode,updated_at)
      SELECT 'test',unnest($1::uuid[]),'human',now()-interval '45 days'`,[ids]);
    await client.query(`INSERT INTO analytics.conversation_facts
      (environment,conversation_id,fact_key,fact_value,truth_type,source,extractor_version,created_at)
      SELECT 'test',unnest($1::uuid[]),'escalou','true'::jsonb,'observed','integration_test','attention_period',now()-interval '45 days'`,[ids]);
    const data=await campainha('test',queryPool);
    expect(data.mudas).toHaveLength(201);expect(data.escalados).toHaveLength(201);
    expect(await humanos(queryPool)).toHaveLength(201);
  });
  it('retira resolvidas e apagadas da fila, sem retomar os controles humanos',async()=>{
    const resolved=await conversation('resolved'),deleted=await conversation(),open=await conversation('pending');
    for(const id of [resolved,deleted,open]) { await message(id,'45 days');await escalation(id,'44 days');await control(id); }
    await client.query('UPDATE core.conversations SET deleted_at=now() WHERE id=$1',[deleted]);
    const data=await campainha('test',queryPool);
    expect(data.mudas.map(row=>row.conversation_id)).toEqual([open]);
    expect(data.escalados.map(row=>row.conversation_id)).toEqual([open]);
    expect((await humanos(queryPool)).map(row=>row.conversation_id)).toEqual([open]);
    expect((await client.query("SELECT mode FROM ops.conversation_bot_control WHERE environment='test'")).rows.every(row=>row.mode==='human')).toBe(true);
  });
  it('preserva a carência de 5 minutos e ignora notas e mensagens apagadas',async()=>{
    const fresh=await conversation(),old=await conversation(),erased=await conversation();
    await message(fresh,'2 minutes');await message(fresh,'45 days');
    await message(old,'45 days');await message(old,'1 minute',{private:true});
    const msg=await message(erased,'45 days');
    await client.query('UPDATE core.messages SET deleted_at=now() WHERE id=$1',[msg.id]);
    expect((await campainha('test',queryPool)).mudas.map(row=>row.conversation_id)).toEqual([old]);
  });
  it('não traz de volta gatilhos já respondidos; falhas e mensagens novas continuam pendentes',async()=>{
    const delivered=await conversation(),ack=await conversation(),failed=await conversation(),newer=await conversation();
    for(const [id,status] of [[delivered,'delivered'],[ack,'sent_api_ack'],[failed,'failed'],[newer,'delivered']]) {
      const trigger=await message(id!,'45 days');await turn(id!,trigger.id,status!);
    }
    await message(newer,'20 minutes');
    expect((await campainha('test',queryPool)).mudas.map(row=>row.conversation_id)).toEqual([failed,newer]);
  });
  it('uma resposta humana pública encerra a espera; nota, atividade e envio falho não',async()=>{
    const answered=await conversation(),note=await conversation(),activity=await conversation(),failed=await conversation();
    for(const id of [answered,note,activity,failed]) await message(id,'45 days');
    await message(answered,'44 days',{sender:'user'});
    await message(note,'44 days',{sender:'user',private:true});
    await message(activity,'44 days',{sender:'user',type:2});
    await message(failed,'44 days',{sender:'user',status:'failed'});
    expect(new Set((await campainha('test',queryPool)).mudas.map(row=>row.conversation_id))).toEqual(new Set([note,activity,failed]));
    await message(answered,'20 minutes');
    expect((await campainha('test',queryPool)).mudas.some(row=>row.conversation_id===answered)).toBe(true);
  });
  it('eco do próprio bot sobre um gatilho velho não esconde a nova pergunta',async()=>{
    const id=await conversation(),old=await message(id,'45 days');
    await message(id,'20 minutes');const echo=await message(id,'19 minutes',{sender:'user'});
    await turn(id,old.id,'delivered',echo.chatwoot_message_id);
    expect((await campainha('test',queryPool)).mudas.map(row=>row.conversation_id)).toEqual([id]);
  });
  it('reconhece eco próprio em envio antes da confirmação do provedor',async()=>{
    const id=await conversation(),old=await message(id,'45 days');
    await message(id,'20 minutes');const echo=await message(id,'19 minutes',{sender:'user'});
    await client.query(`UPDATE core.messages SET content_attributes='{"farejador_echo_id":"attention:fixture"}'::jsonb WHERE id=$1`,[echo.id]);
    await client.query(`INSERT INTO ops.outbound_messages
      (environment,conversation_id,chatwoot_conversation_id,trigger_message_id,kind,body,body_sha256,status,echo_id,attempts)
      SELECT 'test',id,chatwoot_conversation_id,$2,'agent_text','fixture','hash','sending','attention:fixture',1
      FROM core.conversations WHERE id=$1`,[id,old.id]);
    expect((await campainha('test',queryPool)).mudas.map(row=>row.conversation_id)).toEqual([id]);
  });
  it('considera a mensagem nova mesmo antes da carência em um encaminhamento antigo',async()=>{
    const id=await conversation();await escalation(id,'45 days');await message(id,'1 minute');
    const data=await campainha('test',queryPool);
    expect(data.mudas).toEqual([]);expect(data.escalados).toHaveLength(1);
    expect(new Date(data.escalados[0]!.last_customer_at!).getTime()).toBeGreaterThan(new Date(data.escalados[0]!.quando).getTime());
  });
  it('retomada explícita encerra só o encaminhamento antigo; a espera não é resolvida pelo clique',async()=>{
    const old=await conversation(),newer=await conversation(),negative=await conversation();
    await escalation(old,'45 days');await control(old,'auto','44 days');await message(old,'46 days');
    await escalation(newer,'43 days');await control(newer,'auto','44 days');
    await escalation(negative,'45 days',false);
    expect((await campainha('test',queryPool)).escalados.map(row=>row.conversation_id)).toEqual([newer]);
    expect((await campainha('test',queryPool)).mudas.map(row=>row.conversation_id)).toEqual([old]);
  });
  it('mantém motivo antigo e usa o mais recente, sem corte de 48h',async()=>{
    const id=await conversation();await escalation(id,'45 days');
    await client.query(`INSERT INTO analytics.conversation_facts
      (environment,conversation_id,fact_key,fact_value,truth_type,source,extractor_version,created_at)
      VALUES ('test',$1,'motivo_escalacao','"Z antigo"','observed','integration_test','attention_period',now()-interval '45 days'),
             ('test',$1,'motivo_escalacao','"A recente"','observed','integration_test','attention_period',now()-interval '44 days')`,[id]);
    expect((await campainha('test',queryPool)).escalados[0]?.motivo).toBe('A recente');
  });
  it('não mistura ambientes e não cria jobs ou mensagens ao consultar a fila',async()=>{
    const test=await conversation(),prod=await conversation('open','prod');
    await message(test,'45 days');await message(prod,'45 days',{environment:'prod'});
    await control(test);await message(test,'10 minutes');
    const before=(await client.query('SELECT count(*) FROM core.messages')).rows;
    expect((await campainha('test',queryPool)).mudas.map(row=>row.conversation_id)).toEqual([test]);
    expect((await campainha('prod',queryPool)).mudas.map(row=>row.conversation_id)).toEqual([prod]);
    const human=(await humanos(queryPool))[0];expect(human.last_customer_at).toBeTruthy();
    expect((await client.query('SELECT count(*) FROM core.messages')).rows).toEqual(before);
    expect((await client.query('SELECT count(*) FROM ops.atendente_jobs')).rows[0].count).toBe('0');
    expect((await client.query('SELECT count(*) FROM ops.outbound_messages')).rows[0].count).toBe('0');
  });
});
