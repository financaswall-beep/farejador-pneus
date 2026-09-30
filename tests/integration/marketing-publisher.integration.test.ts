import {beforeAll,afterAll,beforeEach,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import type {Pool} from 'pg';
vi.mock('../../src/shared/config/env.js',()=>({env:{FAREJADOR_ENV:'test',MARKETING_PUBLISHER_ENABLED:true,
  MARKETING_MEDIA_MAX_MB:500,MARKETING_LIBRARY_MAX_MB:20000,META_GRAPH_API_VERSION:'v26.0'}}));
vi.mock('../../src/persistence/db.js',()=>({pool:{}}));
import {saveDraft,submitPost,postAction} from '../../src/marketing/publisher/posts.js';
import {claimDelivery} from '../../src/marketing/publisher/queue.js';
import {publishTick} from '../../src/marketing/publisher/worker.js';
import {deleteMedia,cleanupMedia} from '../../src/marketing/publisher/cleanup.js';
import {MetaCommentError} from '../../src/social-comments/graph.js';
import {reconcileDestination} from '../../src/marketing/publisher/reconciliation.js';
import {PublisherError} from '../../src/marketing/publisher/model.js';
import {startPostgres,stopPostgres,type IntegrationDb} from './helpers/postgres.js';
import type {PublisherStorage} from '../../src/marketing/publisher/storage.js';

let pool:Pool;let container:IntegrationDb|undefined;let embedded:any;
const env='test' as const;const graph={assertPermissions:vi.fn(),prepare:vi.fn(),ready:vi.fn(),publish:vi.fn(),verify:vi.fn(),reconcile:vi.fn()};
const storage={assertPrivateBucket:vi.fn().mockResolvedValue({maxBytes:null,allowedMimes:null}),
  signedUrl:vi.fn().mockResolvedValue('https://storage.invalid/signed'),remove:vi.fn().mockResolvedValue(undefined)} as unknown as PublisherStorage;
beforeAll(async()=>{
  if(process.env.PUBLISHER_EMBEDDED_DB==='1') {
    // Fallback explícito para execução local sem Docker. Não usa URLs nem credenciais do projeto.
    const packagePath=pathToFileURL(resolve('artifacts/publisher-validation/node_modules/@electric-sql/pglite/dist/index.js')).href;
    const {PGlite}=await import(packagePath);embedded=new PGlite();
    await embedded.exec(`CREATE TYPE env_t AS ENUM('prod','test');CREATE SCHEMA ops;CREATE SCHEMA analytics;
      CREATE ROLE farejador_partner_app;CREATE FUNCTION ops.enforce_environment_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.environment IS DISTINCT FROM OLD.environment THEN RAISE EXCEPTION 'environment_immutable';END IF;RETURN NEW;END $$;`);
    await embedded.exec(await readFile('db/migrations/0246_marketing_publisher.sql','utf8'));
    await embedded.exec(await readFile('db/migrations/0247_marketing_publisher_recovery.sql','utf8'));
    const query=async(sql:string,params?:unknown[])=>{
      const result=await embedded.query(sql,params);
      for(const row of result.rows)for(const key of ['created_at','updated_at','scheduled_at','started_at','public_started_at','lease_until','deleted_at'])if(row[key]&&!(row[key] instanceof Date))row[key]=new Date(row[key]);
      return {...result,rowCount:result.rows.length||result.affectedRows||0};
    };
    pool={query,connect:async()=>({query,release:()=>undefined})} as unknown as Pool;
  }else{container=await startPostgres();pool=container.pool;}
},180000);
afterAll(async()=>{if(container)await stopPostgres(container);if(embedded)await embedded.close();});
beforeEach(async()=>{
  await pool.query('TRUNCATE ops.publisher_events,ops.publisher_destinations,ops.publisher_posts,ops.publisher_media,analytics.publisher_captions');
  vi.clearAllMocks();graph.assertPermissions.mockResolvedValue(undefined);graph.prepare.mockResolvedValue('301');
  graph.ready.mockResolvedValue(true);graph.publish.mockResolvedValue('302');graph.verify.mockResolvedValue({confirmed:true,url:'https://www.instagram.com/p/302/'});
  graph.reconcile.mockResolvedValue({outcome:'unknown',evidence:'ambiguous'});
  vi.mocked(storage.assertPrivateBucket).mockResolvedValue({maxBytes:null,allowedMimes:null});
});
async function asset(environment='test') {
  const id=randomUUID();await pool.query(`INSERT INTO ops.publisher_media(environment,id,name,kind,mime,bytes,status,original_path,publish_path,thumbnail_path,width,height,duration,created_by,inspection)
    VALUES($1,$2,'video.mp4','video','video/mp4',500,'ready',$3,$3,$4,1080,1920,50,'test',
      '{"verified":true,"video_codec":"h264","fps":30,"bit_rate":3000000,"audio_codec":"aac","audio_sample_rate":48000}')`,
    [environment,id,`${environment}/${id}/original.mp4`,`${environment}/${id}/thumbnail.jpg`]);return id;
}
async function post(media_id:string,destinations:any[]=[{platform:'instagram',format:'reel'},{platform:'facebook',format:'reel'}]) {
  return saveDraft(pool,env,randomUUID(),{version:0,title:'Vídeo 2W',media_id,caption:'Pneus',destinations,delete_after_publish:true},'owner');
}
async function due(){await pool.query(`UPDATE ops.publisher_destinations SET next_attempt_at=now()-interval '1 second',lease_until=NULL WHERE environment='test'`);}
async function finish(){for(let i=0;i<12;i++){await due();if(!await publishTick(pool,env,graph,storage))break;}}
it('aplica schema com RLS; portal parceiro não consegue ler nenhuma das cinco tabelas',async()=>{
  const result=await pool.query(`SELECT c.relname,c.relrowsecurity,has_table_privilege('farejador_partner_app',c.oid,'SELECT') readable
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relname LIKE 'publisher_%' AND n.nspname IN ('ops','analytics') AND c.relkind='r'`);
  expect(result.rows).toHaveLength(5);for(const row of result.rows)expect(row).toMatchObject({relrowsecurity:true,readable:false});
});
it('submissão é idempotente e edição antiga não reescreve uma publicação em andamento',async()=>{
  const p=await post(await asset());
  const first=await submitPost(pool,env,p.id,p.version,null,'owner');
  const repeated=await submitPost(pool,env,p.id,p.version,null,'owner');expect(repeated.id).toBe(first.id);
  expect((await pool.query('SELECT * FROM ops.publisher_destinations')).rows).toHaveLength(2);
  await expect(saveDraft(pool,env,p.id,{version:p.version,title:'Mudei',media_id:p.media_id,caption:'',destinations:[],delete_after_publish:true},'owner')).rejects.toThrow('publisher_version_conflict');
});
it('agendamento em Brasília não sai antes do horário e cancelamento impede o envio',async()=>{
  const p=await post(await asset());const future=new Date(Date.now()+3600000).toISOString();
  await submitPost(pool,env,p.id,p.version,future,'owner');expect(await claimDelivery(pool,env)).toBeNull();
  await postAction(pool,env,p.id,'cancel','owner');await due();expect(await publishTick(pool,env,graph,storage)).toBe(false);expect(graph.publish).not.toHaveBeenCalled();
});
it('confirma todas as redes antes de apagar original, mantendo a miniatura e a auditoria',async()=>{
  const id=await asset();const p=await post(id);await submitPost(pool,env,p.id,p.version,null,'owner');
  await publishTick(pool,env,graph,storage);await cleanupMedia(pool,env,storage);expect(storage.remove).not.toHaveBeenCalled();
  await finish();expect(graph.publish).toHaveBeenCalledTimes(2);
  expect((await pool.query('SELECT status FROM ops.publisher_posts')).rows[0].status).toBe('published');
  await cleanupMedia(pool,env,storage);expect(storage.remove).toHaveBeenCalledWith([`test/${id}/original.mp4`,`test/${id}/original.mp4`]);
  expect((await pool.query('SELECT status,thumbnail_path FROM ops.publisher_media')).rows[0]).toMatchObject({status:'deleted',thumbnail_path:`test/${id}/thumbnail.jpg`});
  expect((await pool.query(`SELECT * FROM ops.publisher_events WHERE event='delivery_published'`)).rows).toHaveLength(2);
});
it('preserva arquivo compartilhado por outro rascunho; remove só quando ele for descartado',async()=>{
  const id=await asset();const published=await post(id);const draft=await post(id);
  await submitPost(pool,env,published.id,published.version,null,'owner');await finish();await cleanupMedia(pool,env,storage);
  expect(storage.remove).not.toHaveBeenCalled();await expect(deleteMedia(pool,env,id,false,storage)).rejects.toThrow('publisher_media_in_use');
  await postAction(pool,env,draft.id,'cancel','owner');await cleanupMedia(pool,env,storage);expect(storage.remove).toHaveBeenCalledOnce();
});
it('uma rede falha: reenvia apenas ela e não duplica a que publicou',async()=>{
  const id=await asset();const p=await post(id);await submitPost(pool,env,p.id,p.version,null,'owner');
  graph.publish.mockImplementation(async(d:any)=>{if(d.platform==='facebook')throw new MetaCommentError('meta_http_400_code_200');return '302';});
  await finish();expect((await pool.query('SELECT status FROM ops.publisher_posts')).rows[0].status).toBe('partial');
  await cleanupMedia(pool,env,storage);expect(storage.remove).not.toHaveBeenCalled();
  await postAction(pool,env,p.id,'retry','owner');graph.publish.mockResolvedValue('303');await finish();
  expect(graph.publish.mock.calls.filter(([d])=>d.platform==='instagram')).toHaveLength(1);
  expect(graph.publish.mock.calls.filter(([d])=>d.platform==='facebook')).toHaveLength(2);
  expect((await pool.query('SELECT status FROM ops.publisher_posts')).rows[0].status).toBe('published');
});
it('respeita a escolha de manter a mídia em outra publicação concluída',async()=>{
  const id=await asset();const first=await post(id);const retained=await post(id);
  await pool.query(`UPDATE ops.publisher_posts SET delete_after_publish=false WHERE id=$1`,[retained.id]);
  await submitPost(pool,env,first.id,first.version,null,'owner');await submitPost(pool,env,retained.id,retained.version,null,'owner');
  await finish();await finish();await cleanupMedia(pool,env,storage);expect(storage.remove).not.toHaveBeenCalled();
  await deleteMedia(pool,env,id,false,storage);expect(storage.remove).toHaveBeenCalledOnce();
});
it('timeout público e reinício durante envio ficam incertos e não são repetidos',async()=>{
  const id=await asset();const p=await post(id,[{platform:'instagram',format:'reel'}]);await submitPost(pool,env,p.id,p.version,null,'owner');
  await publishTick(pool,env,graph,storage);await due();graph.publish.mockRejectedValue(new MetaCommentError('meta_connection_unknown',true));
  await publishTick(pool,env,graph,storage);expect((await pool.query('SELECT status FROM ops.publisher_destinations')).rows[0].status).toBe('uncertain');
  await expect(postAction(pool,env,p.id,'retry','owner')).rejects.toThrow('publisher_retry_not_allowed');
  await pool.query(`UPDATE ops.publisher_posts SET status='publishing'`);
  await pool.query(`UPDATE ops.publisher_destinations SET status='publishing'`);
  await due();await publishTick(pool,env,graph,storage);expect(graph.publish).toHaveBeenCalledTimes(1);
  await cleanupMedia(pool,env,storage);expect(storage.remove).not.toHaveBeenCalled();
});
it('produção e teste não compartilham mídia nem rascunho',async()=>{
  const prod=await asset('prod');await expect(post(prod)).rejects.toThrow('publisher_media_not_ready');
  const p=await post(await asset());expect((await pool.query(`SELECT * FROM ops.publisher_posts WHERE environment='prod'`)).rows).toHaveLength(0);
  await expect(pool.query(`UPDATE ops.publisher_posts SET environment='prod' WHERE id=$1`,[p.id])).rejects.toThrow();
});
it('texto de IA é imutável; correção usa outra linha e não muda ambiente',async()=>{
  const id=(await pool.query(`INSERT INTO analytics.publisher_captions(environment,brief,caption,extractor_version,confidence_level,model)
    VALUES('test','Pneus','Legenda','v1','low','model') RETURNING id`)).rows[0].id;
  await expect(pool.query('UPDATE analytics.publisher_captions SET caption=$2 WHERE id=$1',[id,'Nova'])).rejects.toThrow('publisher_caption_immutable');
  await expect(pool.query('DELETE FROM analytics.publisher_captions WHERE id=$1',[id])).rejects.toThrow('publisher_caption_immutable');
});
async function uncertainPost() {
  const p=await post(await asset(),[{platform:'instagram',format:'reel'}]);
  await submitPost(pool,env,p.id,p.version,null,'owner');
  await pool.query(`UPDATE ops.publisher_destinations SET status='uncertain',container_id='301',provider_id=NULL WHERE post_id=$1`,[p.id]);
  await pool.query(`UPDATE ops.publisher_posts SET status='failed' WHERE id=$1`,[p.id]);
  return {...p,version:p.version+1};
}
it('conciliação confirma prova positiva e audita o operador sem enviar de novo',async()=>{
  const p=await uncertainPost();
  const input={version:p.version,platform:'instagram' as const,decision:'published' as const,confirmed:true as const,
    provider_id:'302',note:'Conferi a publicação na conta da matriz.'};
  graph.reconcile.mockResolvedValue({outcome:'published',provider_id:'302',url:'https://www.instagram.com/p/302/',evidence:'provider_published_owned'});
  await expect(reconcileDestination(pool,env,p.id,{...input,version:1},'Owner',graph)).rejects.toThrow('publisher_version_conflict');
  const resolved=await reconcileDestination(pool,env,p.id,input,'Owner',graph);
  expect(resolved.status).toBe('published');await finish();expect(graph.publish).not.toHaveBeenCalled();
  const event=(await pool.query(`SELECT actor,payload FROM ops.publisher_events WHERE event='delivery_reconciled'`)).rows[0];
  expect(event.actor).toBe('Owner');expect(event.payload).toMatchObject({decision:'published',previous_status:'uncertain',provider_id:'302'});
});
it('declaração humana não libera reenvio; prova negativa terminal libera apenas retry explícito',async()=>{
  const p=await uncertainPost();
  const input={version:p.version,platform:'instagram' as const,decision:'not_published' as const,confirmed:true as const,
    note:'Consultei a conta e revisei o estado deste envio.'};
  await expect(reconcileDestination(pool,env,p.id,input,'Owner',graph)).rejects.toThrow('publisher_reconciliation_ambiguous');
  expect((await pool.query('SELECT status FROM ops.publisher_destinations')).rows[0].status).toBe('uncertain');
  graph.reconcile.mockResolvedValue({outcome:'not_published',evidence:'provider_terminal_failure'});
  await reconcileDestination(pool,env,p.id,input,'Owner',graph);await due();
  expect(await publishTick(pool,env,graph,storage)).toBe(false);expect(graph.publish).not.toHaveBeenCalled();
  await postAction(pool,env,p.id,'retry','Owner');await finish();expect(graph.publish).toHaveBeenCalledOnce();
});
it('conciliação por link persiste somente prova positiva da Meta e não reenvia',async()=>{
  const p=await uncertainPost();
  const input={version:p.version,platform:'instagram' as const,decision:'published' as const,confirmed:true as const,
    post_url:'https://instagram.com/reel/ABC/?igsh=tracking',note:'Copiei o link e conferi o Reel na conta.'};
  graph.reconcile.mockResolvedValueOnce({outcome:'unknown',evidence:'publication_link_not_found'});
  await expect(reconcileDestination(pool,env,p.id,input,'Owner',graph)).rejects.toThrow('publisher_post_url_not_found');
  expect((await pool.query('SELECT status,provider_id FROM ops.publisher_destinations')).rows[0])
    .toMatchObject({status:'uncertain',provider_id:null});
  const verifiedUrl='https://www.instagram.com/p/ABC/';
  graph.reconcile.mockResolvedValueOnce({outcome:'published',provider_id:'302',url:verifiedUrl,evidence:'provider_published_owned'});
  await reconcileDestination(pool,env,p.id,input,'Owner',graph);await finish();
  expect((await pool.query('SELECT status,provider_id,post_url FROM ops.publisher_destinations')).rows[0])
    .toMatchObject({status:'published',provider_id:'302',post_url:verifiedUrl});
  expect(graph.publish).not.toHaveBeenCalled();
  const event=(await pool.query(`SELECT actor,payload FROM ops.publisher_events WHERE event='delivery_reconciled'`)).rows[0];
  expect(event).toMatchObject({actor:'Owner',payload:{evidence:'provider_published_owned',provider_id:'302'}});
});
it('submissão de vídeo AAC em 44,1 kHz usa o mesmo motor sem conversão obrigatória',async()=>{
  const id=await asset();
  await pool.query(`UPDATE ops.publisher_media SET inspection=jsonb_set(inspection,'{audio_sample_rate}','44100') WHERE id=$1`,[id]);
  const p=await post(id,[{platform:'instagram',format:'reel'}]);
  await submitPost(pool,env,p.id,p.version,null,'Owner');await finish();
  expect(graph.publish).toHaveBeenCalledOnce();
  expect((await pool.query('SELECT status FROM ops.publisher_posts')).rows[0].status).toBe('published');
});
it('encerrar resultado ambíguo preserva arquivo e não permite reenvio automático',async()=>{
  const p=await uncertainPost();
  await reconcileDestination(pool,env,p.id,{version:p.version,platform:'instagram',decision:'abandon',confirmed:true,
    note:'Revisei e encerrei esta tentativa sem reenviar.'},'Owner',graph);
  expect((await pool.query('SELECT status,delete_after_publish FROM ops.publisher_posts')).rows[0])
    .toMatchObject({status:'cancelled',delete_after_publish:false});
  await finish();await cleanupMedia(pool,env,storage);
  expect(graph.reconcile).not.toHaveBeenCalled();expect(graph.publish).not.toHaveBeenCalled();expect(storage.remove).not.toHaveBeenCalled();
  await expect(postAction(pool,env,p.id,'retry','Owner')).rejects.toThrow('publisher_retry_not_allowed');
});
it('falha temporária antes do envio aguarda backoff e se recupera sem duplicar',async()=>{
  const p=await post(await asset(),[{platform:'instagram',format:'reel'}]);await submitPost(pool,env,p.id,p.version,null,'Owner');
  graph.prepare.mockRejectedValueOnce(new MetaCommentError('meta_http_503_code_2'));
  await publishTick(pool,env,graph,storage);
  const row=(await pool.query('SELECT status,retry_attempts,next_attempt_at FROM ops.publisher_destinations')).rows[0];
  expect(row).toMatchObject({status:'preparing',retry_attempts:1});
  expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now()+10000);
  expect(await publishTick(pool,env,graph,storage)).toBe(false);
  await finish();expect(graph.publish).toHaveBeenCalledOnce();expect((await pool.query('SELECT status FROM ops.publisher_posts')).rows[0].status).toBe('published');
});
it('falhas temporárias têm limite e bucket público bloqueia a chamada irreversível',async()=>{
  const p=await post(await asset(),[{platform:'instagram',format:'reel'}]);await submitPost(pool,env,p.id,p.version,null,'Owner');
  graph.prepare.mockRejectedValue(new MetaCommentError('meta_http_503_code_2'));
  for(let i=0;i<6;i++){await due();await publishTick(pool,env,graph,storage);}
  expect((await pool.query('SELECT status,retry_attempts FROM ops.publisher_destinations')).rows[0].status).toBe('failed');
  expect(graph.publish).not.toHaveBeenCalled();
  graph.prepare.mockResolvedValue('301');await postAction(pool,env,p.id,'retry','Owner');
  await due();await publishTick(pool,env,graph,storage);await due();
  vi.mocked(storage.assertPrivateBucket).mockRejectedValue(new PublisherError('publisher_bucket_must_be_private',503));
  await publishTick(pool,env,graph,storage);expect(graph.publish).not.toHaveBeenCalled();
});
