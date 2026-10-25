import { beforeAll,afterAll,describe,it,expect,vi } from 'vitest';
import { createHash,randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { startPostgres,stopPostgres,type IntegrationDb } from './helpers/postgres.js';
vi.mock('../../src/atendente-v2/configured-routing.js',()=>({decideConfiguredStore:async()=>({kind:'matriz',canFulfill:true})}));
vi.mock('../../src/atendente-v2/customer-location.js',()=>({resolveCustomerLocation:async()=>({lat:-22.9,lng:-43.2})}));
vi.mock('../../src/atendente-v2/delivery-quote-routing.js',()=>({fillCityFromPin:async(_c:unknown,_e:unknown,_id:unknown,current:unknown)=>current}));
let db:IntegrationDb,product:string,main:string,partner:string,conversation:string,contact:string;
let save:typeof import('../../src/catalog-photos/repository.js').saveCatalogPhoto;
let update:typeof import('../../src/catalog-photos/repository.js').updatePhotoSettings;
let request:typeof import('../../src/catalog-photos/bot.js').tryMatrixCatalogPhoto;
let env:typeof import('../../src/shared/config/env.js').env;
let image:Buffer;
const storage={ensureBucket:vi.fn(async()=>{}),put:vi.fn(async()=>{}),read:vi.fn(async()=>image)};
beforeAll(async()=>{
 db=await startPostgres();
 Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:db.connectionString,CHATWOOT_HMAC_SECRET:'test',ADMIN_AUTH_TOKEN:'test',
  MATRIZ_CATALOG_PHOTOS_ENABLED:'true',BOT_OUTBOX:'true',AGENT_V2_CONVERSATION_IDS:'*',PHOTO_REQUESTS:'true',ROUTING_GEO:'true',PARTNER_STOCK_CONFIRMATION:'false'});
 await (await import('./helpers/store-opening-fixtures.js')).configureTestOpeningHours(db.pool);
 const repository=await import('../../src/catalog-photos/repository.js');save=repository.saveCatalogPhoto;update=repository.updatePhotoSettings;
 request=(await import('../../src/catalog-photos/bot.js')).tryMatrixCatalogPhoto;
 env=(await import('../../src/shared/config/env.js')).env;
 main=(await db.pool.query(`INSERT INTO core.units(environment,slug,name,is_active) VALUES('test','main','Matriz',true)
  ON CONFLICT(environment,slug) DO UPDATE SET is_active=true RETURNING id`)).rows[0].id;
 partner=(await db.pool.query(`INSERT INTO core.units(environment,slug,name,is_active) VALUES('test','photo-partner','Loja parceira',true) RETURNING id`)).rows[0].id;
 product=(await db.pool.query(`INSERT INTO commerce.products(environment,product_code,product_name,product_type,brand,tire_condition)
  VALUES('test','MATRIX-PHOTO','Pneu Rinaldi 110/90-17','tire','Rinaldi','novo') RETURNING id`)).rows[0].id;
 await db.pool.query(`INSERT INTO commerce.tire_specs(environment,product_id,tire_size) VALUES('test',$1,'110/90-17')`,[product]);
 contact=(await db.pool.query(`INSERT INTO core.contacts(environment,chatwoot_contact_id,name) VALUES('test',991991,'Cliente de teste') RETURNING id`)).rows[0].id;
 conversation=(await db.pool.query(`INSERT INTO core.conversations(environment,chatwoot_conversation_id,chatwoot_account_id,contact_id,current_status,started_at)
  VALUES('test',991991,1,$1,'open',now()) RETURNING id`,[contact])).rows[0].id;
 image=await sharp({create:{width:800,height:600,channels:3,background:'#445566'}}).jpeg().toBuffer();
},180000);
afterAll(async()=>{if(db)await stopPostgres(db);});
async function ask(args:Record<string,unknown>={},unit=main,prod=product,environment:'test'|'prod'='test'){
 const client=await db.pool.connect();try{return await request(client,environment,conversation,prod,unit,args);}finally{client.release();}
}
let seq=992000;
async function message(content:string){await db.pool.query(`INSERT INTO core.messages(environment,conversation_id,chatwoot_conversation_id,chatwoot_message_id,
 sender_type,message_type,is_private,content,sent_at)
 VALUES('test',$1,991991,$2,'contact',0,false,$3,now()+($2::bigint-992000)*interval '1 second')`,[conversation,++seq,content]);}
describe('galeria isolada e envio real pelo outbox',()=>{
 it('sem foto e em parceiro continua pelo fluxo sob demanda',async()=>{
  expect(await ask()).toBeNull();expect(await ask({},partner)).toBeNull();
 });
 it('guarda um original e um derivado privado e torna a primeira foto principal',async()=>{
  const result=await save(db.pool,{environment:'test',productId:product,angle:'front',bytes:image,source:'upload',sourceKey:'fixture-1',actor:'teste'},storage as never);
  expect(result.duplicate).toBe(false);expect(storage.put).toHaveBeenCalledTimes(2);
  expect((await db.pool.query(`SELECT is_primary FROM commerce.matrix_catalog_photos WHERE id=$1`,[result.id])).rows[0].is_primary).toBe(true);
  const duplicate=await save(db.pool,{environment:'test',productId:product,angle:'front',bytes:image,source:'upload',sourceKey:'fixture-1',actor:'teste'},storage as never);
  expect(duplicate).toMatchObject({id:result.id,duplicate:true});expect(storage.put).toHaveBeenCalledTimes(2);
 });
 it('enfileira a foto exata uma vez por mensagem e aceita outro pedido explícito depois',async()=>{
  await message('Pode mandar a foto do pneu?');expect(JSON.parse((await ask())!)).toMatchObject({status:'foto_enfileirada',origem:'galeria_matriz'});
  expect(JSON.parse((await ask())!).status).toBe('foto_ja_enfileirada');
  expect((await db.pool.query(`SELECT count(*) n FROM ops.outbound_messages WHERE environment='test'`)).rows[0].n).toBe('1');
  await message('Manda a foto de novo por favor');expect(JSON.parse((await ask())!).status).toBe('foto_enfileirada');
  const rows=(await db.pool.query(`SELECT body FROM ops.outbound_messages WHERE environment='test'`)).rows;
  expect(rows).toHaveLength(2);expect(JSON.parse(rows[0].body).caption).toBe('');
 });
 it('não cruza produto, ambiente, parceiro nem inventa ângulo ausente',async()=>{
  expect(await ask({},partner)).toBeNull();expect(await ask({},main,randomUUID())).toBeNull();
  expect(await ask({},main,product,'prod')).toBeNull();expect(await ask({tipo_foto:'lateral'})).toBeNull();
 });
 it('pedido de foto atual ou de desgaste continua pedindo à loja',async()=>{
  await message('Me mostra o estado e os sulcos desse pneu');expect(await ask()).toBeNull();
  await message('Pode mandar foto?');expect(await ask({foto_atual:true})).toBeNull();
 });
 it('a última guarda aceita foto cadastrada após retomada e o histórico distingue fila de envio confirmado',async()=>{
  const {prepareControlledOutbound}=await import('../../src/atendente-v2/outbound-control.js');
  const {loadConversationPhotoStatus}=await import('../../src/atendente-v2/photo-status.js');
  await db.pool.query(`INSERT INTO ops.conversation_bot_control(environment,conversation_id,mode,resumed_at)
   VALUES('test',$1,'auto',now()-interval '1 hour') ON CONFLICT(environment,conversation_id) DO UPDATE SET mode='auto',resumed_at=excluded.resumed_at`,[conversation]);
  const row=(await db.pool.query(`UPDATE ops.outbound_messages SET status='sending' WHERE id=(SELECT id FROM ops.outbound_messages WHERE environment='test' ORDER BY created_at LIMIT 1) RETURNING *`)).rows[0];
  const client=await db.pool.connect();try{
   expect(await prepareControlledOutbound(client,row)).toBe(true);
   expect((await loadConversationPhotoStatus(client,'test',conversation)).some(photo=>photo.status==='queued')).toBe(true);
   await client.query(`UPDATE ops.outbound_messages SET status='sent_api_ack',sent_at=now() WHERE id=$1`,[row.id]);
   expect((await loadConversationPhotoStatus(client,'test',conversation)).some(photo=>photo.status==='sent')).toBe(true);
  }finally{client.release();}
  await db.pool.query('DELETE FROM ops.conversation_bot_control WHERE environment=\'test\' AND conversation_id=$1',[conversation]);
 });
 it('respeita pausa do bot, desativação da foto, versão e substituição do arquivo',async()=>{
  await db.pool.query(`INSERT INTO ops.conversation_bot_control(environment,conversation_id,mode) VALUES('test',$1,'human')`,[conversation]);
  await message('Pode mandar foto do modelo?');expect(JSON.parse((await ask())!).status).toBe('foto_nao_enfileirada');
  await db.pool.query('DELETE FROM ops.conversation_bot_control WHERE conversation_id=$1',[conversation]);
  await update(db.pool,'test',product,{version:1,enabled:false});expect(await ask()).toBeNull();
  await expect(update(db.pool,'test',product,{version:1,enabled:true})).rejects.toMatchObject({code:'settings_changed'});
  await update(db.pool,'test',product,{version:2,enabled:true});
  const replaced=await save(db.pool,{environment:'test',productId:product,angle:'front',bytes:image,source:'upload',sourceKey:'fixture-2',actor:'teste'},storage as never);
  expect((await db.pool.query(`SELECT count(*) n FROM commerce.matrix_catalog_photos WHERE product_id=$1 AND retired_at IS NULL`,[product])).rows[0].n).toBe('1');
  expect((await db.pool.query(`SELECT count(*) n FROM commerce.matrix_catalog_photos WHERE product_id=$1`,[product])).rows[0].n).toBe('2');
  expect(replaced.duplicate).toBe(false);
 });
 it('não expõe tabelas ao parceiro e não aceita ID de produto de outro ambiente',async()=>{
  const permissions=(await db.pool.query(`SELECT has_table_privilege('farejador_partner_app','commerce.matrix_catalog_photos','SELECT') readable`)).rows[0];
  expect(permissions.readable).toBe(false);
  await expect(save(db.pool,{environment:'prod',productId:product,angle:'side',bytes:image,source:'upload',sourceKey:'wrong-env',actor:'teste'},storage as never)).rejects.toMatchObject({code:'product_not_found'});
  env.MATRIZ_CATALOG_PHOTOS_ENABLED=false;expect(await ask()).toBeNull();env.MATRIZ_CATALOG_PHOTOS_ENABLED=true;
 });
 it('importa automaticamente, deduplica, reconhece mudança de ângulo e preserva a foto se o checksum falhar',async()=>{
  const {syncOneCatalogFolder}=await import('../../src/catalog-photos/worker.js');
  const version=(await db.pool.query(`SELECT version FROM commerce.matrix_photo_settings WHERE environment='test' AND product_id=$1`,[product])).rows[0].version;
  await update(db.pool,'test',product,{version,drive_folder_id:'folder_1234567890',drive_enabled:true});
  const file={id:'file_1234567890',name:'principal.jpg',mimeType:'image/jpeg',size:String(image.length),
   modifiedTime:'2026-10-25T00:00:00Z',md5Checksum:createHash('md5').update(image).digest('hex'),capabilities:{canDownload:true}};
  const drive={folderPhotos:vi.fn(async()=>({files:[file],token:'test-only'})),download:vi.fn(async()=>image)};
  const sync=async()=>{await db.pool.query(`UPDATE commerce.matrix_photo_settings SET drive_checked_at=NULL WHERE environment='test' AND product_id=$1`,[product]);
   await syncOneCatalogFolder(db.pool,drive as never,storage as never);};
  await sync();expect(drive.download).toHaveBeenCalledTimes(1);
  await sync();expect(drive.download).toHaveBeenCalledTimes(1);
  file.name='lateral.jpg';await sync();expect(drive.download).toHaveBeenCalledTimes(2);
  expect((await db.pool.query(`SELECT angle,is_primary,source FROM commerce.matrix_catalog_photos WHERE product_id=$1 AND retired_at IS NULL`,[product])).rows)
   .toEqual([{angle:'side',is_primary:true,source:'drive'}]);
  file.md5Checksum='0'.repeat(32);file.modifiedTime='2026-10-25T00:01:00Z';await sync();
  expect((await db.pool.query(`SELECT drive_error FROM commerce.matrix_photo_settings WHERE product_id=$1`,[product])).rows[0].drive_error).toBe('drive_photo_changed');
  expect((await db.pool.query(`SELECT count(*) n FROM commerce.matrix_catalog_photos WHERE product_id=$1 AND retired_at IS NULL`,[product])).rows[0].n).toBe('1');
 });
 it('pedir_foto usa a galeria e pede foto à Matriz quando falta o ângulo, sem segunda chamada do cliente',async()=>{
  const {executeTool}=await import('../../src/atendente-v2/tools.js');
  const {withStoreOpeningContext}=await import('../../src/atendente-v2/routing-store-hours.js');
  await message('Pode mandar a foto do modelo?');
  const client=await db.pool.connect();try{
   await client.query('BEGIN');
   const call=(args:Record<string,unknown>)=>withStoreOpeningContext('test',()=>executeTool(client,'test',conversation,'pedir_foto',{
    product_id:product,municipio:'Rio de Janeiro',...args}),new Date('2026-10-23T15:00:00Z'));
   expect(JSON.parse(await call({}))).toMatchObject({status:'foto_enfileirada',origem:'galeria_matriz'});
   expect(JSON.parse(await call({tipo_foto:'detalhe'}))).toMatchObject({status:'foto_solicitada'});
   expect((await client.query(`SELECT unit_id FROM commerce.photo_requests WHERE environment='test'`)).rows).toEqual([{unit_id:main}]);
  }finally{await client.query('ROLLBACK');client.release();}
 });
 it('envia referência da Matriz à meia-noite, sem estoque e sem exigir localização; foto atual continua com a equipe',async()=>{
  const {executeTool}=await import('../../src/atendente-v2/tools.js');
  const {withStoreOpeningContext}=await import('../../src/atendente-v2/routing-store-hours.js');
  const {tryRequestedMatrixCatalogPhoto}=await import('../../src/catalog-photos/bot.js');
  await message('Quero uma foto de referência do pneu da Matriz');
  const client=await db.pool.connect();try{
   await client.query('BEGIN');
   await client.query(`UPDATE commerce.matriz_delivery_settings SET settings=jsonb_set(settings,'{store_hours}',
    '[{"day":1,"opens_at":"08:00","closes_at":"18:00"}]'::jsonb) WHERE environment='test'`);
   expect((await client.query(`SELECT count(*) n FROM commerce.stock_levels WHERE environment='test' AND product_id=$1`,[product])).rows[0].n).toBe('0');
   const call=(args:Record<string,unknown>)=>withStoreOpeningContext('test',()=>executeTool(client,'test',conversation,'pedir_foto',{
    product_id:product,...args}),new Date('2026-10-25T03:15:00Z'));
   expect(await tryRequestedMatrixCatalogPhoto(client,'test',conversation,product,{})).toBeNull();
   const out=JSON.parse(await call({loja:'matriz'}));
   expect(out).toMatchObject({status:'foto_enfileirada',origem:'galeria_matriz',tipo:'referencia'});
   expect(out.orientacao).toContain('Estes controles são internos');
   const rows=await client.query(`SELECT body FROM ops.outbound_messages WHERE environment='test' AND conversation_id=$1 AND kind='photo_attachment' AND trigger_message_id=
    (SELECT id FROM core.messages WHERE environment='test' AND conversation_id=$1 ORDER BY sent_at DESC,id DESC LIMIT 1)`,[conversation]);
   expect(rows.rows).toHaveLength(1);expect(JSON.parse(rows.rows[0].body)).toMatchObject({product_id:product,unit_id:main});
   expect((await client.query(`SELECT count(*) n FROM commerce.photo_requests WHERE environment='test'`)).rows[0].n).toBe('0');
   const actual=JSON.parse(await call({loja:'matriz',foto_atual:true,municipio:'Rio de Janeiro'}));
   expect(actual).toMatchObject({erro:'lojas_fechadas',atendimento_agora:false});
   expect((await client.query(`SELECT count(*) n FROM commerce.photo_requests WHERE environment='test'`)).rows[0].n).toBe('0');
  }finally{await client.query('ROLLBACK');client.release();}
 });
});
