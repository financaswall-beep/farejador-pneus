import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {startPostgres,stopPostgres,type IntegrationDb} from './helpers/postgres.js';

describe('Comentários Meta — fluxo automático isolado',()=>{
  let db:IntegrationDb;
  let ingest:typeof import('../../src/social-comments/ingest.js');
  let worker:typeof import('../../src/social-comments/worker.js');
  let store:typeof import('../../src/social-comments/store.js');
  let dashboard:typeof import('../../src/social-comments/dashboard.js');
  const config={enabled:true,publish:true,pageId:'100',instagramId:'200',apiVersion:'v21.0',token:'ficticio'};
  const graph:any={assertAccount:vi.fn(async()=>undefined),post:vi.fn(async()=>({caption:'Pneus de moto',url:'https://www.facebook.com/100/posts/80'})),
    comment:vi.fn(),reply:vi.fn(async()=> '100_999'),remove:vi.fn(async()=>undefined)};
  let time=1770000000;
  beforeAll(async()=>{
    Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:'postgres://unused',CHATWOOT_HMAC_SECRET:'ficticio',ADMIN_AUTH_TOKEN:'ficticio',
      META_COMMENTS_ENABLED:'true',META_COMMENTS_PAGE_ID:'100',META_COMMENTS_INSTAGRAM_ID:'200'});
    db=await startPostgres({throughMigration:'0242_meta_comments.sql'});
    ingest=await import('../../src/social-comments/ingest.js');worker=await import('../../src/social-comments/worker.js');store=await import('../../src/social-comments/store.js');dashboard=await import('../../src/social-comments/dashboard.js');
  },180000);
  afterAll(async()=>{if(db)await stopPostgres(db);});
  async function receive(commentId:string,body:string,extra:Record<string,unknown>={},environment='test'){
    const payload={object:'page',entry:[{id:'100',time:++time,changes:[{field:'feed',value:{item:'comment',verb:'add',post_id:'100_80',comment_id:commentId,message:body,from:{id:'300',name:'Cliente fictício'},...extra}}]}]};
    const row=await db.pool.query(`INSERT INTO raw.meta_messaging_events(environment,payload_sha256,signature,object_type,payload)
      VALUES($1,$2,'sha256=ficticio','page',$3) RETURNING id`,[environment,time.toString(16).padStart(64,'0'),JSON.stringify(payload)]);
    await db.pool.query(`INSERT INTO ops.meta_comment_events(environment,raw_event_id) VALUES($1,$2)`,[environment,row.rows[0].id]);
    await ingest.normalizeCommentEvent(db.pool,config);
    return db.pool.query(`SELECT c.id,c.body,c.revision,a.status,a.decision_id FROM core.meta_comments c
      JOIN ops.meta_comment_actions a ON a.environment=c.environment AND a.comment_id=c.id
      WHERE c.environment=$1 AND c.comment_id=$2`,[environment,commentId]);
  }
  const decide:any=async(body:string)=>({model:'modelo-ficticio',inputTokens:10,outputTokens:20,decision:
    body.includes('péssimo') ? {action:'delete',sentiment:'negative',reply_text:'',reason:'Crítica ao atendimento',confidence_level:'high'}
    : {action:'reply',sentiment:'neutral',reply_text:'Chama no privado que a gente confere pra você!',reason:'Dúvida comercial',confidence_level:'high'}});
  it('recebe, decide e responde uma vez; reentrega não duplica',async()=>{
    const input='Tem 130/70-13?';const row=await receive('100_1',input);expect(row.rows[0].status).toBe('pending');
    await worker.processComment({pool:db.pool,config,graph,decide});
    graph.comment.mockResolvedValue({body:input,authorId:'300'});
    await worker.publishComment({pool:db.pool,config,graph});
    expect(graph.reply).toHaveBeenCalledTimes(1);
    await receive('100_1',input);await worker.processComment({pool:db.pool,config,graph,decide});await worker.publishComment({pool:db.pool,config,graph});
    expect(graph.reply).toHaveBeenCalledTimes(1);
    const decisions=await db.pool.query(`SELECT * FROM analytics.meta_comment_decisions WHERE comment_id=$1`,[row.rows[0].id]);
    expect(decisions.rows).toHaveLength(1);expect(decisions.rows[0]).toMatchObject({source:'llm',truth_type:'inferred',comment_snapshot:input});
  });
  it('apaga negativo e mantém comentário/motivo; não publica resposta junto',async()=>{
    const body='Atendimento péssimo';const row=await receive('100_2',body);
    await worker.processComment({pool:db.pool,config,graph,decide});graph.comment.mockResolvedValue({body,authorId:'300'});
    await worker.publishComment({pool:db.pool,config,graph});expect(graph.remove).toHaveBeenCalledWith('100_2');
    expect(graph.reply).toHaveBeenCalledTimes(1);
    const data=await dashboard.commentsDashboard(db.pool);expect(data.summary.deleted).toBe(1);
    expect(data.rows.find((r:any)=>r.id===row.rows[0].id)).toMatchObject({body,status:'deleted',action:'delete'});
  });
  it('edição durante a análise invalida a decisão antiga',async()=>{
    await receive('100_3','Atendimento péssimo');const task=await store.claimComment(db.pool,'generation');
    expect(task?.comment_id).toBe('100_3');await receive('100_3','Não sei a medida');
    await store.saveDecision(db.pool,task!,await decide('Atendimento péssimo'));
    expect((await db.pool.query(`SELECT status FROM ops.meta_comment_actions WHERE comment_id=$1`,[task!.id])).rows[0].status).toBe('pending');
    await worker.processComment({pool:db.pool,config,graph,decide});graph.comment.mockResolvedValue({body:'Não sei a medida',authorId:'300'});
    await worker.publishComment({pool:db.pool,config,graph});expect(graph.reply).toHaveBeenCalledTimes(2);
  });
  it('remoção cancela a fila e preserva o texto original',async()=>{
    await receive('100_4','Preço?');const r=await receive('100_4','',{verb:'remove'});
    expect(r.rows[0]).toMatchObject({status:'ignored',body:'Preço?'});
    expect(await worker.processComment({pool:db.pool,config,graph,decide})).toBe(false);
  });
  it('resposta própria encerra a fila sem criar um ciclo',async()=>{
    const r=await receive('100_5','Bom dia');await receive('100_51','Oi!',{parent_id:'100_5',from:{id:'100'}});
    expect((await db.pool.query(`SELECT status FROM ops.meta_comment_actions WHERE comment_id=$1`,[r.rows[0].id])).rows[0].status).toBe('replied');
    expect(await worker.processComment({pool:db.pool,config,graph,decide})).toBe(false);
  });
  it('escrita com resposta perdida fica incerta e não se repete',async()=>{
    const body='Oi';const r=await receive('100_6',body);await worker.processComment({pool:db.pool,config,graph,decide});
    graph.comment.mockResolvedValue({body,authorId:'300'});graph.reply.mockRejectedValueOnce(new Error('Resposta perdida'));
    await worker.publishComment({pool:db.pool,config,graph});
    expect((await db.pool.query(`SELECT status FROM ops.meta_comment_actions WHERE comment_id=$1`,[r.rows[0].id])).rows[0].status).toBe('uncertain');
    const count=graph.reply.mock.calls.length;await worker.publishComment({pool:db.pool,config,graph});expect(graph.reply).toHaveBeenCalledTimes(count);
  });
  it('isolamento de ambiente, imutabilidade e pausa',async()=>{
    await receive('100_7','Oi',{},'prod');expect((await db.pool.query(`SELECT * FROM core.meta_comments WHERE environment='prod'`)).rowCount).toBe(0);
    const raw=await db.pool.query(`SELECT id FROM raw.meta_messaging_events LIMIT 1`);
    await expect(db.pool.query(`UPDATE raw.meta_messaging_events SET payload='{}' WHERE id=$1`,[raw.rows[0].id])).rejects.toThrow(/imutavel/);
    const d=await db.pool.query(`SELECT id FROM analytics.meta_comment_decisions LIMIT 1`);
    await expect(db.pool.query(`UPDATE analytics.meta_comment_decisions SET reply_text='reescrever' WHERE id=$1`,[d.rows[0].id])).rejects.toThrow(/imutavel/);
    await db.pool.query(`INSERT INTO ops.meta_comment_controls(environment,paused,updated_by) VALUES('test',true,'fixture')`);
    await receive('100_8','Oi');expect(await worker.processComment({pool:db.pool,config,graph,decide})).toBe(false);
    expect(await worker.publishComment({pool:db.pool,config,graph})).toBe(false);
  });
  it('resposta da página não é atribuída à IA; webhook adiantado não perde confirmação da IA',async()=>{
    await db.pool.query(`UPDATE ops.meta_comment_controls SET paused=false WHERE environment='test'`);
    // Limpa a pendência deixada de propósito pelo teste da pausa.
    await db.pool.query(`UPDATE ops.meta_comment_actions SET status='ignored' WHERE environment='test' AND status='pending'`);
    const r=await receive('100_9','Oi, tudo bem?');
    await worker.processComment({pool:db.pool,config,graph,decide});
    await receive('100_91','Oi!',{parent_id:'100_9',from:{id:'100'}});
    expect(await worker.publishComment({pool:db.pool,config,graph})).toBe(false);
    expect((await dashboard.commentsDashboard(db.pool)).rows.find((x:any)=>x.id===r.rows[0].id)).toMatchObject({status:'replied',completion_source:'page'});
    const r2=await receive('100_10','Bom dia!');
    await worker.processComment({pool:db.pool,config,graph,decide});
    graph.comment.mockResolvedValue({body:'Bom dia!',authorId:'300'});
    graph.reply.mockImplementationOnce(async()=>{
      await receive('100_101','Bom dia!',{parent_id:'100_10',from:{id:'100'}});
      return '100_101';
    });
    await worker.publishComment({pool:db.pool,config,graph});
    expect((await dashboard.commentsDashboard(db.pool)).rows.find((x:any)=>x.id===r2.rows[0].id)).toMatchObject({status:'replied',completion_source:'automation'});
  });
  it('resultado de análise expirada não sobrescreve quem retomou a tarefa',async()=>{
    const r=await receive('100_11','Tem 90/90-12?');
    const old=await store.claimComment(db.pool,'generation');
    await db.pool.query(`UPDATE ops.meta_comment_actions SET updated_at=now()-interval '4 minutes' WHERE comment_id=$1`,[r.rows[0].id]);
    await store.recoverCommentLeases(db.pool);
    const current=await store.claimComment(db.pool,'generation');
    expect(current!.lease_id).not.toBe(old!.lease_id);
    await store.saveDecision(db.pool,old!,await decide('Tem 90/90-12?'));
    await store.finishComment(db.pool,old!,'generating','failed');
    expect((await db.pool.query(`SELECT status FROM ops.meta_comment_actions WHERE comment_id=$1`,[r.rows[0].id])).rows[0].status).toBe('generating');
    await store.saveDecision(db.pool,current!,await decide('Tem 90/90-12?'));
    expect((await db.pool.query(`SELECT count(*)::int AS total FROM analytics.meta_comment_decisions WHERE comment_id=$1`,[r.rows[0].id])).rows[0].total).toBe(1);
  });
  it.each(['reply','delete'])('token de outra conta impede %s mesmo com ação pronta',async(action)=>{
    await db.pool.query(`UPDATE ops.meta_comment_actions SET status='ignored' WHERE environment='test' AND status='queued'`);
    const body=action==='reply'?'Qual a medida?':'Atendimento péssimo';
    const r=await receive(action==='reply'?'100_12':'100_13',body);
    await worker.processComment({pool:db.pool,config,graph,decide});
    const {MetaCommentError}=await import('../../src/social-comments/graph.js');
    graph.assertAccount.mockRejectedValueOnce(new MetaCommentError('meta_token_page_mismatch'));
    const replies=graph.reply.mock.calls.length,removals=graph.remove.mock.calls.length;
    await worker.publishComment({pool:db.pool,config,graph});
    expect(graph.reply).toHaveBeenCalledTimes(replies);
    expect(graph.remove).toHaveBeenCalledTimes(removals);
    expect((await dashboard.commentsDashboard(db.pool)).rows.find((row:any)=>row.id===r.rows[0].id))
      .toMatchObject({status:'failed',error_code:'meta_token_page_mismatch'});
  });
});
