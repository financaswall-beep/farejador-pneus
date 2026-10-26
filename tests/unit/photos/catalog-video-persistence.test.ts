import {describe,it,expect,vi} from 'vitest';
Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:'postgres://unused',CHATWOOT_HMAC_SECRET:'test',ADMIN_AUTH_TOKEN:'test'});
const {saveCatalogVideo}=await import('../../../src/catalog-photos/video-repository.js');
const id='11111111-1111-4111-8111-111111111111';
const input={environment:'test' as const,productId:id,bytes:Buffer.from('input'),source:'upload' as const,sourceKey:'fixture',actor:'fixture'};
const prepare=async()=>({video:Buffer.from('mp4'),width:1280,height:720,duration:15});
function query(sql:string){
 if(sql.startsWith('SELECT 1'))return {rowCount:1,rows:[{id}]};
 if(sql.includes('SELECT * FROM commerce.matrix_photo_settings'))return {rowCount:1,rows:[{enabled:true}]};
 return {rowCount:0,rows:[]};
}
function fixture(failure:'upload'|'connect'|'insert'|'commit'){
 const client={query:vi.fn(async(sql:string)=>{
  if(failure==='insert'&&sql.includes('INSERT INTO commerce.matrix_catalog_videos'))throw Error('constraint');
  if(failure==='commit'&&sql==='COMMIT')throw Error('connection_lost_after_commit');
  return query(sql);
 }),release:vi.fn()};
 const db={query:vi.fn(async(sql:string)=>query(sql)),connect:vi.fn(async()=>{if(failure==='connect')throw Error('connection_failed');return client;})};
 const storage={ensureBucket:vi.fn(async()=>{}),put:vi.fn(async()=>{if(failure==='upload')throw Error('upload_result_unknown');}),remove:vi.fn(async()=>{})};
 return {db,storage,client};
}
describe('vídeo: compensação entre banco e Storage',()=>{
 it.each(['upload','connect','insert'] as const)('remove apenas o arquivo novo em falha de %s, antes de confirmar no banco',async(failure)=>{
  const {db,storage}=fixture(failure);
  await expect(saveCatalogVideo(db as never,input,storage as never,prepare)).rejects.toBeDefined();
  expect(storage.put).toHaveBeenCalledTimes(1);expect(storage.remove).toHaveBeenCalledTimes(1);
  expect(storage.remove.mock.calls[0][0]).toMatch(new RegExp('^test/'+id+'/[a-f0-9-]{36}/video\\.mp4$'));
 });
 it('preserva o arquivo se o COMMIT ficou incerto, para não apagar vídeo que já esteja em uso',async()=>{
  const {db,storage,client}=fixture('commit');
  await expect(saveCatalogVideo(db as never,input,storage as never,prepare)).rejects.toThrow('connection_lost_after_commit');
  expect(storage.remove).not.toHaveBeenCalled();expect(client.release).toHaveBeenCalled();
 });
});
