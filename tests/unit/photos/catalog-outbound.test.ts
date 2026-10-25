import { beforeEach,describe,expect,it,vi } from 'vitest';
import sharp from 'sharp';
const mocks=vi.hoisted(()=>({read:vi.fn(),send:vi.fn(),message:vi.fn()}));
vi.mock('../../../src/shared/config/env.js',()=>({env:{MATRIZ_CATALOG_PHOTOS_ENABLED:true}}));
vi.mock('../../../src/catalog-photos/storage.js',()=>({CatalogPhotoStorage:class {read=mocks.read;}}));
vi.mock('../../../src/photos/storage.js',()=>({readStoredTirePhoto:vi.fn()}));
vi.mock('../../../src/atendente-v2/sender.js',()=>({sendAttachmentOnce:mocks.send,sendMessageOnce:mocks.message,resolveConversationOnce:vi.fn()}));
import { deliverOutboundRow,markPhotoRequestSent } from '../../../src/atendente-v2/outbound-delivery.js';
const row={id:'out',environment:'test' as const,conversation_id:'conversation',turn_id:null,chatwoot_conversation_id:9876,
 kind:'photo_attachment',echo_id:'stable-catalog-echo',attempts:0,body:JSON.stringify({catalog_photo_id:'photo',product_id:'product',unit_id:'main-unit',caption:'Foto de referência: Pneu Rinaldi.'})};
beforeEach(()=>{vi.clearAllMocks();mocks.send.mockResolvedValue({chatwootMessageId:123});});
describe('anexo do catálogo no sender existente',()=>{
 it('lê o Storage privado, converte para JPEG e envia à conversa correta com a mesma chave de dedup',async()=>{
  mocks.read.mockResolvedValue(await sharp({create:{width:200,height:200,channels:3,background:'black'}}).webp().toBuffer());
  const client={query:vi.fn(async()=>({rows:[{storage_path:'private-catalog-path'}]}))};
  await expect(deliverOutboundRow(client as never,row)).resolves.toEqual({chatwootMessageId:123});
  expect(mocks.read).toHaveBeenCalledWith('private-catalog-path');
  const [conversation,file,caption,echo]=mocks.send.mock.calls[0];
  expect(conversation).toBe(9876);expect(file.contentType).toBe('image/jpeg');
  expect((await sharp(file.buffer).metadata()).format).toBe('jpeg');
  expect(caption).toContain('referência');expect(echo).toBe('stable-catalog-echo');expect(mocks.message).not.toHaveBeenCalled();
  await markPhotoRequestSent(client as never,row);expect(client.query).toHaveBeenCalledTimes(1);
 });
 it('não envia arquivo retirado, produto alterado para outra unidade ou uso desativado',async()=>{
  const client={query:vi.fn(async()=>({rows:[]}))};
  await expect(deliverOutboundRow(client as never,row)).rejects.toThrow('catalog_photo_revoked');
  expect(mocks.read).not.toHaveBeenCalled();expect(mocks.send).not.toHaveBeenCalled();
  expect(client.query.mock.calls[0][0]).toContain("u.slug='main'");
 });
 it('envia a foto sem legenda técnica, mantendo anexo e deduplicação',async()=>{
  mocks.read.mockResolvedValue(await sharp({create:{width:200,height:200,channels:3,background:'black'}}).webp().toBuffer());
  const client={query:vi.fn(async()=>({rows:[{storage_path:'private-catalog-path'}]}))};
  await deliverOutboundRow(client as never,{...row,body:JSON.stringify({...JSON.parse(row.body),caption:''})});
  expect(mocks.send.mock.calls[0]?.[2]).toBe('');expect(mocks.send.mock.calls[0]?.[3]).toBe('stable-catalog-echo');
  expect(mocks.message).not.toHaveBeenCalled();
 });
});
