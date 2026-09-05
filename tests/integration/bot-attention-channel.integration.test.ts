import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { startPostgres,stopPostgres,type IntegrationDb } from './helpers/postgres';
let db:IntegrationDb;
let campainha:typeof import('../../src/admin/painel/queries-bot').getBotCampainha;
let humanos:typeof import('../../src/admin/painel/bot-conversation-control').listHumanControlledConversations;
const ids:string[]=[];
beforeAll(async () => {
  db=await startPostgres();
  Object.assign(process.env,{ NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:db.connectionString,
    CHATWOOT_HMAC_SECRET:'fixture',ADMIN_AUTH_TOKEN:'fixture' });
  ({getBotCampainha:campainha}=await import('../../src/admin/painel/queries-bot'));
  ({listHumanControlledConversations:humanos}=await import('../../src/admin/painel/bot-conversation-control'));
  for (const [i,channel] of ['Channel::Whatsapp','Channel::Instagram','Channel::Facebook',null].entries()) {
    const native=7100+i;
    const contact=(await db.pool.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name)
      VALUES ('test',$1,$2) RETURNING id`,[native,`Fixture ${i}`])).rows[0].id;
    const id=(await db.pool.query(`INSERT INTO core.conversations(environment,chatwoot_conversation_id,
      chatwoot_account_id,contact_id,channel_type,current_status,started_at)
      VALUES ('test',$1,2,$2,$3,'open',now()) RETURNING id`,[native,contact,channel])).rows[0].id;
    ids.push(id);
    await db.pool.query(`INSERT INTO core.messages(environment,conversation_id,chatwoot_conversation_id,
      chatwoot_message_id,sender_type,message_type,is_private,content,sent_at)
      VALUES ('test',$1,$2,$2,'contact',0,false,'fixture',now()-interval '20 minutes')`,[id,native]);
  }
  await db.pool.query(`INSERT INTO ops.conversation_bot_control(environment,conversation_id,mode)
    VALUES ('test',$1,'human')`,[ids[1]]);
  await db.pool.query(`INSERT INTO analytics.conversation_facts
    (environment,conversation_id,fact_key,fact_value,truth_type,source,extractor_version)
    VALUES ('test',$1,'escalou','true'::jsonb,'observed','integration_test','bot_attention_fixture')`,[ids[2]]);
});
afterAll(async()=>{ if(db) await stopPostgres(db); });
describe('canal e modo na fila de atenção',() => {
  it('devolve o canal comprovado e o modo da conversa sem presumir WhatsApp',async () => {
    const data=await campainha('test',db.pool);
    expect(data.mudas).toHaveLength(4);
    const rows=new Map(data.mudas.map(row=>[row.conversation_id,row]));
    expect(rows.get(ids[0]!)).toMatchObject({ channel_type:'Channel::Whatsapp',bot_mode:'auto' });
    expect(rows.get(ids[1]!)).toMatchObject({ channel_type:'Channel::Instagram',bot_mode:'human' });
    expect(rows.get(ids[2]!)).toMatchObject({ channel_type:'Channel::Facebook',bot_mode:'auto' });
    expect(rows.get(ids[3]!)).toMatchObject({ channel_type:null,bot_mode:'auto' });
  });
  it('inclui o canal também na lista de atendimentos assumidos por humanos',async () => {
    expect(await humanos(db.pool)).toEqual([expect.objectContaining({conversation_id:ids[1],channel_type:'Channel::Instagram',mode:'human'})]);
  });
  it('preserva a origem e o modo também nas conversas escaladas pelo bot',async () => {
    expect((await campainha('test',db.pool)).escalados).toEqual([expect.objectContaining({
      conversation_id:ids[2],channel_type:'Channel::Facebook',bot_mode:'auto',
    })]);
  });
  it('não mistura os ambientes',async () => {
    expect(await campainha('prod',db.pool)).toEqual({ mudas:[],escalados:[] });
  });
});
