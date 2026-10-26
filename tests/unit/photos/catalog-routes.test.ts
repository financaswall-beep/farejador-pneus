import Fastify from 'fastify';
import { beforeEach,describe,expect,it,vi } from 'vitest';
const mocks=vi.hoisted(()=>({list:vi.fn(),save:vi.fn(),update:vi.fn(),photo:vi.fn(),read:vi.fn(),saveVideo:vi.fn(),video:vi.fn(),readVideo:vi.fn()}));
vi.mock('../../../src/catalog-photos/video-repository.js',()=>({saveCatalogVideo:mocks.saveVideo,readCatalogVideo:mocks.video}));
vi.mock('../../../src/catalog-photos/video-storage.js',()=>({CatalogVideoStorage:class {read=mocks.readVideo;}}));
vi.mock('../../../src/shared/config/env.js',()=>({env:{FAREJADOR_ENV:'test',MATRIZ_CATALOG_PHOTOS_ENABLED:true,PHOTO_REQUESTS:true,BOT_OUTBOX:true}}));
vi.mock('../../../src/persistence/db.js',()=>({pool:{}}));
vi.mock('../../../src/admin/auth.js',()=>({requireAdminOwner:async(request:any,reply:any)=>{
 if(request.headers.authorization!=='owner')reply.code(403).send({error:'owner_required'});
}}));
vi.mock('../../../src/admin/painel/route-helpers.js',()=>({operatorLabel:()=> 'Owner fixture'}));
vi.mock('../../../src/catalog-photos/drive.js',()=>({catalogDriveStatus:()=>({configured:false,email:null})}));
vi.mock('../../../src/catalog-photos/storage.js',()=>({catalogStorageReady:()=>true,MAX_CATALOG_PHOTO_BYTES:10*1024*1024,
 CatalogPhotoStorage:class {read=mocks.read;}}));
vi.mock('../../../src/catalog-photos/repository.js',()=>({listCatalogPhotos:mocks.list,saveCatalogPhoto:mocks.save,
 updatePhotoSettings:mocks.update,readCatalogPhoto:mocks.photo}));
import { registerCatalogPhotoRoutes } from '../../../src/admin/painel/route-catalogo-photos.js';
const id='11111111-1111-4111-8111-111111111111';
beforeEach(()=>{vi.clearAllMocks();mocks.list.mockResolvedValue({rows:[]});});
describe('rotas de fotos: owner e escopo de sessão',()=>{
 it('bloqueia consulta, upload, alteração e imagem antes de operar dados para quem não é owner',async()=>{
  const app=Fastify();registerCatalogPhotoRoutes(app);
  for(const request of [{method:'GET',url:'/admin/api/catalog/photos'},{method:'POST',url:`/admin/api/catalog/${id}/photos?angle=front`},
   {method:'PATCH',url:`/admin/api/catalog/${id}/photo-settings`},{method:'GET',url:`/admin/api/catalog/photos/${id}/image`},
   {method:'POST',url:`/admin/api/catalog/${id}/videos`},{method:'GET',url:`/admin/api/catalog/videos/${id}/file`}])
   expect((await app.inject(request as never)).statusCode).toBe(403);
  expect(mocks.list).not.toHaveBeenCalled();expect(mocks.save).not.toHaveBeenCalled();expect(mocks.read).not.toHaveBeenCalled();await app.close();
 });
 it('serve vídeo somente com a sessão owner do app, sem token na URL, e valida upload antes de salvar',async()=>{
  const app=Fastify();registerCatalogPhotoRoutes(app,{base:'/api/caixa/operacao/catalogo'});
  mocks.video.mockResolvedValue({storage_path:'private-video'});mocks.readVideo.mockResolvedValue(Buffer.from('mp4'));
  const url=`/api/caixa/operacao/catalogo/videos/${id}/file`;
  expect((await app.inject({url})).statusCode).toBe(403);
  const response=await app.inject({url,headers:{authorization:'owner'}});
  expect(response.statusCode).toBe(200);expect(response.headers['content-type']).toContain('video/mp4');
  expect(response.headers['cache-control']).toBe('private, no-store');expect(mocks.readVideo).toHaveBeenCalledWith('private-video');
  const upload=`/api/caixa/operacao/catalogo/${id}/videos`;
  expect((await app.inject({method:'POST',url:upload,headers:{authorization:'owner','content-type':'video/mp4'},payload:Buffer.from('mp4')})).statusCode).toBe(400);
  mocks.saveVideo.mockResolvedValue({id,duplicate:false});
  expect((await app.inject({method:'POST',url:upload,headers:{authorization:'owner','content-type':'video/mp4','x-upload-id':id},payload:Buffer.from('mp4')})).statusCode).toBe(200);
  expect(mocks.saveVideo).toHaveBeenCalledWith({},expect.objectContaining({environment:'test',productId:id,source:'upload',actor:'Owner fixture'}));
  await app.close();
 });
 it('mantém o ambiente no servidor e recusa versão ou pasta inválida sem alterar o vínculo',async()=>{
  const app=Fastify();registerCatalogPhotoRoutes(app);
  expect((await app.inject({url:'/admin/api/catalog/photos?environment=prod',headers:{authorization:'owner'}})).statusCode).toBe(200);
  expect(mocks.list).toHaveBeenCalledWith({},'test');
  for(const payload of [{version:0,enabled:true},{version:1,drive_folder_id:'https://evil.example/folder'},
   {version:1,enabled:true,environment:'prod'}])expect((await app.inject({method:'PATCH',url:`/admin/api/catalog/${id}/photo-settings`,headers:{authorization:'owner'},payload})).statusCode).toBe(400);
  expect(mocks.update).not.toHaveBeenCalled();await app.close();
 });
 it('aceita os guardas próprios do app e serve a imagem privada sem credencial na URL',async()=>{
  const app=Fastify(),guard=vi.fn(async(request:any,reply:any)=>{if(request.headers.authorization!=='Bearer cs_fixture')reply.code(401).send({error:'session'});});
  registerCatalogPhotoRoutes(app,{base:'/api/caixa/operacao/catalogo',guards:[guard],actor:()=> 'App owner'});
  mocks.photo.mockResolvedValue({storage_path:'private-photo',original_path:'private-original'});mocks.read.mockResolvedValue(Buffer.from('image-fixture'));
  const url=`/api/caixa/operacao/catalogo/photos/${id}/image`;
  expect((await app.inject({url})).statusCode).toBe(401);
  const response=await app.inject({url,headers:{authorization:'Bearer cs_fixture'}});
  expect(response.statusCode).toBe(200);expect(response.headers['content-type']).toContain('image/webp');
  expect(response.headers['cache-control']).toBe('private, no-store');expect(mocks.read).toHaveBeenCalledWith('private-photo');await app.close();
 });
});
