import { generateKeyPairSync } from 'node:crypto';
import { beforeAll,describe,expect,it,vi } from 'vitest';
vi.mock('../../../src/shared/config/env.js',()=>({env:{MATRIZ_PHOTOS_DRIVE_SERVICE_ACCOUNT_JSON:undefined}}));
import { env } from '../../../src/shared/config/env.js';
import { CatalogDrive } from '../../../src/catalog-photos/drive.js';
const credential={type:'service_account',client_email:'photos@test-project.iam.gserviceaccount.com',private_key_id:'a'.repeat(40),
 private_key:generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'}).toString(),
 token_uri:'https://evil.example/token',subject:'other@example.com'};
beforeAll(()=>{env.MATRIZ_PHOTOS_DRIVE_SERVICE_ACCOUNT_JSON=JSON.stringify(credential);});
describe('Drive do catálogo: escopo mínimo e pasta explícita',()=>{
 it('usa somente OAuth oficial read-only e consulta apenas a pasta vinculada',async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(Response.json({access_token:'fixture-token'}))
   .mockResolvedValueOnce(Response.json({mimeType:'application/vnd.google-apps.folder'}))
   .mockResolvedValueOnce(Response.json({files:[]}));
  const result=await new CatalogDrive(fetcher as typeof fetch).folderPhotos('folder_1234567890');
  expect(result.files).toEqual([]);
  const claims=JSON.parse(Buffer.from((fetcher.mock.calls[0][1].body as URLSearchParams).get('assertion')!.split('.')[1],'base64url').toString());
  expect(claims.scope).toBe('https://www.googleapis.com/auth/drive.readonly');expect(claims).not.toHaveProperty('sub');
  expect(fetcher.mock.calls[0][0]).toBe('https://oauth2.googleapis.com/token');
  const list=new URL(fetcher.mock.calls[2][0]);expect(list.origin).toBe('https://www.googleapis.com');
  expect(list.searchParams.get('q')).toContain("'folder_1234567890' in parents");
  expect(list.searchParams.get('q')).toContain('trashed = false');
  expect(fetcher.mock.calls.every(call=>call[1].redirect==='error')).toBe(true);
 });
 it('não trata consulta incompleta como pasta vazia',async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(Response.json({access_token:'fixture-token'}))
   .mockResolvedValueOnce(Response.json({mimeType:'application/vnd.google-apps.folder'}))
   .mockResolvedValueOnce(Response.json({files:[],nextPageToken:'more'}));
  await expect(new CatalogDrive(fetcher as typeof fetch).folderPhotos('folder_1234567890')).rejects.toMatchObject({code:'drive_folder_too_large'});
 });
 it('rejeita pasta removida e download proibido ou grande sem acessar outra URL',async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(Response.json({access_token:'fixture-token'}))
   .mockResolvedValueOnce(Response.json({mimeType:'application/vnd.google-apps.folder',trashed:true}));
  const drive=new CatalogDrive(fetcher as typeof fetch);
  await expect(drive.folderPhotos('folder_1234567890')).rejects.toMatchObject({code:'invalid_drive_folder'});
  const photo={id:'photo_1234567890',name:'principal.jpg',mimeType:'image/jpeg',size:'500',md5Checksum:'a'.repeat(32),modifiedTime:'2026-10-25T00:00:00Z',capabilities:{canDownload:false}};
  await expect(drive.download(photo,'fixture-token')).rejects.toMatchObject({code:'drive_photo_unavailable'});
  await expect(drive.download({...photo,capabilities:{canDownload:true},size:String(11*1024*1024)},'fixture-token')).rejects.toMatchObject({code:'photo_too_large'});
  expect(fetcher).toHaveBeenCalledTimes(2);
 });
});
