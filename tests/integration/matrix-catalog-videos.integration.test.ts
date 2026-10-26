import { beforeAll,afterAll,describe,it,expect,vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startPostgres,stopPostgres,type IntegrationDb } from './helpers/postgres.js';
const transport=vi.hoisted(()=>({send:vi.fn(async()=>({chatwootMessageId:884411}))}));
vi.mock('../../src/atendente-v2/sender.js',()=>({sendAttachmentOnce:transport.send,sendMessageOnce:vi.fn(),resolveConversationOnce:vi.fn()}));
let db:IntegrationDb,product:string,other:string,main:string,partner:string,conversation:string;
let repository:typeof import('../../src/catalog-photos/video-repository.js');
let bot:typeof import('../../src/catalog-photos/video-bot.js');
let env:typeof import('../../src/shared/config/env.js').env;
let activeVideo:string;
const video=Buffer.from('encoded-mp4-fixture');
const storage={ensureBucket:vi.fn(async()=>{}),put:vi.fn(async()=>{}),read:vi.fn(async()=>video),remove:vi.fn(async()=>{})};
const prepare=vi.fn(async()=>({video,width:1280,height:720,duration:15}));
beforeAll(async()=>{
 db=await startPostgres();
 Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:db.connectionString,DATABASE_SSL:'false',
  CHATWOOT_HMAC_SECRET:'test',ADMIN_AUTH_TOKEN:'test',MATRIZ_CATALOG_PHOTOS_ENABLED:'true',BOT_OUTBOX:'true',PHOTO_REQUESTS:'true',AGENT_V2_CONVERSATION_IDS:'*'});
 repository=await import('../../src/catalog-photos/video-repository.js');bot=await import('../../src/catalog-photos/video-bot.js');
 env=(await import('../../src/shared/config/env.js')).env;
 main=(await db.pool.query(`INSERT INTO core.units(environment,slug,name,is_active) VALUES('test','main','Matriz',true)
  ON CONFLICT(environment,slug) DO UPDATE SET is_active=true RETURNING id`)).rows[0].id;
 partner=(await db.pool.query(`INSERT INTO core.units(environment,slug,name,is_active) VALUES('test','video-partner','Parceiro',true) RETURNING id`)).rows[0].id;
 for(const [index,code] of ['VIDEO-ONE','VIDEO-TWO'].entries()){
  const id=(await db.pool.query(`INSERT INTO commerce.products(environment,product_code,product_name,product_type,brand,tire_condition)
   VALUES('test',$1,$2,'tire','Kenda','meia_vida') RETURNING id`,[code,index?'Pneu Kenda 110/70-13':'Pneu Kenda 100/80-14'])).rows[0].id;
  await db.pool.query(`INSERT INTO commerce.tire_specs(environment,product_id,tire_size) VALUES('test',$1,$2)`,[id,index?'110/70-13':'100/80-14']);
  if(index)other=id;else product=id;
 }
 const contact=(await db.pool.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name) VALUES('test',884401,'Vídeo fixture') RETURNING id`)).rows[0].id;
 conversation=(await db.pool.query(`INSERT INTO core.conversations(environment,chatwoot_conversation_id,chatwoot_account_id,contact_id,current_status,started_at)
  VALUES('test',884401,1,$1,'open',now()) RETURNING id`,[contact])).rows[0].id;
},180000);
afterAll(async()=>{if(db)await stopPostgres(db);});
let seq=884410;
async function incoming(content='Manda um vídeo desse pneu'){
 await db.pool.query(`INSERT INTO core.messages(environment,conversation_id,chatwoot_conversation_id,chatwoot_message_id,sender_type,message_type,is_private,content,sent_at)
 VALUES('test',$1,884401,$2,'contact',0,false,$3,now()+($2::bigint-884410)*interval '1 second')`,[conversation,++seq,content]);
}
async function ask(args:Record<string,unknown>={product_id:product,loja:'matriz'},environment:'test'|'prod'='test'){
 const client=await db.pool.connect();try{return JSON.parse(await bot.requestCatalogVideos(client,environment,conversation,args));}finally{client.release();}
}
describe('vídeos do catálogo: persistência, isolamento e envio controlado',()=>{
 it('salva um único MP4 e repete o upload com a mesma chave sem novo arquivo',async()=>{
  const input={environment:'test' as const,productId:product,bytes:Buffer.from('source'),source:'upload' as const,sourceKey:'fixture-video-1',actor:'fixture'};
  const result=await repository.saveCatalogVideo(db.pool,input,storage as never,prepare);activeVideo=result.id;
  expect(result.duplicate).toBe(false);expect(storage.put).toHaveBeenCalledTimes(1);
  expect(storage.put.mock.calls[0][0]).toMatch(/\/video\.mp4$/);
  expect(await repository.saveCatalogVideo(db.pool,input,storage as never,prepare)).toMatchObject({id:result.id,duplicate:true});
  expect(storage.put).toHaveBeenCalledTimes(1);expect(prepare).toHaveBeenCalledTimes(1);
  const photoRepository=await import('../../src/catalog-photos/repository.js');
  expect((await photoRepository.listCatalogPhotos(db.pool,'test')).rows.find(row=>row.product_id===product)?.video).toMatchObject({id:result.id,file_bytes:video.length});
 });
 it('o original não é coluna nem objeto persistido; a tabela é privada e valida ambiente',async()=>{
  const columns=(await db.pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='commerce' AND table_name='matrix_catalog_videos'")).rows;
  expect(columns.some(row=>row.column_name==='original_path'||row.column_name==='original_bytes')).toBe(false);
  expect((await db.pool.query("SELECT has_table_privilege('farejador_partner_app','commerce.matrix_catalog_videos','SELECT') allowed")).rows[0].allowed).toBe(false);
  await expect(repository.saveCatalogVideo(db.pool,{environment:'prod',productId:product,bytes:Buffer.from('x'),source:'upload',sourceKey:'wrong-env',actor:'fixture'},storage as never,prepare)).rejects.toMatchObject({code:'product_not_found'});
 });
 it('enfileira o vídeo correto uma vez por mensagem e permite nova solicitação explícita',async()=>{
  await incoming();expect((await ask()).solicitacoes[0].status).toBe('video_enfileirado');await ask();
  let rows=(await db.pool.query("SELECT * FROM ops.outbound_messages WHERE environment='test' AND kind='video_attachment'")).rows;
  expect(rows).toHaveLength(1);expect(JSON.parse(rows[0].body)).toMatchObject({catalog_video_id:activeVideo,product_id:product,unit_id:main,caption:''});
  await incoming('Pode mandar o vídeo de novo?');await ask();
  rows=(await db.pool.query("SELECT * FROM ops.outbound_messages WHERE environment='test' AND kind='video_attachment'")).rows;expect(rows).toHaveLength(2);
 });
 it('não troca parceiro por Matriz, não cruza produto/ambiente e relata ausência em lote',async()=>{
  expect((await ask({product_id:product})).status).toBe('video_somente_matriz');
  expect((await ask({product_id:randomUUID(),loja:'matriz'})).status).toBe('precisa_produto');
  expect((await ask(undefined,'prod')).status).toBe('precisa_produto');
  expect((await ask({product_id:product,product_ids:[other],loja:'matriz'})).status).toBe('precisa_produto');
  const result=await ask({product_ids:[product,other],loja:'matriz'});
  expect(result.status).toBe('videos_parciais');expect(result.solicitacoes).toContainEqual({product_id:other,status:'sem_video'});
  await incoming('Preciso de uma gravação atual do exemplar');expect((await ask()).status).toBe('sem_video_atual');
 });
 it('a guarda final bloqueia pausa humana, mídia desativada, loja errada e resposta anterior à retomada',async()=>{
  await incoming();await ask();
  const row=(await db.pool.query("UPDATE ops.outbound_messages SET status='sending' WHERE id=(SELECT id FROM ops.outbound_messages WHERE kind='video_attachment' ORDER BY created_at DESC LIMIT 1) RETURNING *")).rows[0];
  const {prepareControlledOutbound}=await import('../../src/atendente-v2/outbound-control.js');
  const client=await db.pool.connect();try{
   expect(await prepareControlledOutbound(client,row)).toBe(true);
   expect(await bot.authorizedCatalogVideo(client,{...row,body:JSON.stringify({...JSON.parse(row.body),unit_id:partner})})).toBeNull();
   await client.query("UPDATE commerce.matrix_photo_settings SET enabled=false WHERE environment='test' AND product_id=$1",[product]);
   expect(await bot.authorizedCatalogVideo(client,row)).toBeNull();
   await client.query("UPDATE commerce.matrix_photo_settings SET enabled=true WHERE environment='test' AND product_id=$1",[product]);
   await client.query("UPDATE ops.conversation_bot_control SET resumed_at=now()+interval '1 day' WHERE environment='test' AND conversation_id=$1",[conversation]);
   expect(await prepareControlledOutbound(client,row)).toBe(false);
   await client.query("UPDATE ops.conversation_bot_control SET resumed_at=NULL,mode='human' WHERE environment='test' AND conversation_id=$1",[conversation]);
   await incoming();expect((await ask()).solicitacoes[0].status).toBe('video_nao_enfileirado');
   await client.query("UPDATE ops.conversation_bot_control SET mode='auto' WHERE environment='test' AND conversation_id=$1",[conversation]);
  }finally{client.release();}
 });
 it('o dispatcher envia o MP4 como vídeo, sem passar pelo codec de fotos',async()=>{
  const {CatalogVideoStorage}=await import('../../src/catalog-photos/video-storage.js');
  const read=vi.spyOn(CatalogVideoStorage.prototype,'read').mockResolvedValue(video);
  const row=(await db.pool.query("SELECT * FROM ops.outbound_messages WHERE environment='test' AND kind='video_attachment' ORDER BY created_at LIMIT 1")).rows[0];
  const {deliverOutboundRow}=await import('../../src/atendente-v2/outbound-delivery.js');
  const client=await db.pool.connect();try{await deliverOutboundRow(client,row);}finally{client.release();read.mockRestore();}
  expect(transport.send).toHaveBeenCalledWith(884401,expect.objectContaining({buffer:video,filename:'pneu-matriz.mp4',contentType:'video/mp4'}),'',row.echo_id);
 });
 it('substituir o vídeo revoga o arquivo anterior e não remove fotos antigas',async()=>{
  const result=await repository.saveCatalogVideo(db.pool,{environment:'test',productId:product,bytes:Buffer.from('new-source'),source:'upload',sourceKey:'fixture-video-2',actor:'fixture'},storage as never,prepare);
  expect(result.id).not.toBe(activeVideo);expect(await repository.readCatalogVideo(db.pool,'test',activeVideo)).toBeNull();
  expect((await db.pool.query("SELECT count(*)::int n FROM commerce.matrix_catalog_videos WHERE environment='test' AND product_id=$1 AND retired_at IS NULL",[product])).rows[0].n).toBe(1);
  const row=(await db.pool.query("SELECT * FROM ops.outbound_messages WHERE environment='test' AND kind='video_attachment' ORDER BY created_at LIMIT 1")).rows[0];
  const client=await db.pool.connect();try{expect(await bot.authorizedCatalogVideo(client,row)).toBeNull();}finally{client.release();}
  env.MATRIZ_CATALOG_PHOTOS_ENABLED=false;expect((await ask()).status).toBe('video_indisponivel');env.MATRIZ_CATALOG_PHOTOS_ENABLED=true;
 });
});
