import { describe,expect,it,vi } from 'vitest';
vi.mock('../../../src/shared/config/env.js',()=>({env:{
  SUPABASE_STORAGE_URL:'https://photos.supabase.co',SUPABASE_STORAGE_SERVICE_KEY:'server-only-test',
}}));
import { TirePhotoStorage } from '../../../src/photos/storage.js';
const path='test/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333/photo.webp';
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
describe('Storage privado de fotos de pneu',()=>{
  it('recusa bucket público e caminhos fora do namespace',async()=>{
    const fetcher=vi.fn(async()=>json({public:true,file_size_limit:2097152,allowed_mime_types:['image/jpeg','image/webp']}));
    const storage=new TirePhotoStorage(fetcher);
    await expect(storage.ensureBucket()).rejects.toThrow('tire_photo_bucket_policy_invalid');
    fetcher.mockClear();
    await expect(storage.read('../marketing/photo.jpg')).rejects.toThrow('invalid_tire_photo_path');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('cria bucket privado com teto de upload e verifica a configuração antes de usá-lo',async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(json({},404)).mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(json({public:false,file_size_limit:2097152,allowed_mime_types:['image/jpeg','image/webp']}));
    await new TirePhotoStorage(fetcher).ensureBucket();
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({public:false,file_size_limit:2097152});
  });
  it('URL assinada fica limitada ao arquivo; a chave de serviço não entra na resposta',async()=>{
    const upload=path.replace('photo.webp','upload.jpg');
    const fetcher=vi.fn(async()=>json({url:'/object/upload/sign/farejador-tire-photos/'+upload+'?token=opaque'}));
    const url=await new TirePhotoStorage(fetcher).uploadUrl(upload);
    expect(url).toBe('https://photos.supabase.co/storage/v1/object/upload/sign/farejador-tire-photos/'+upload+'?token=opaque');
    expect(url).not.toContain('server-only-test');
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer server-only-test');
  });
  it('não baixa bytes sem limite e remove por API, preservando o bucket de marketing',async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(new Response(Buffer.alloc(2000))).mockResolvedValueOnce(json([]));
    const storage=new TirePhotoStorage(fetcher);
    await expect(storage.read(path,1000)).rejects.toThrow('tire_photo_too_large');
    await storage.remove([path]);
    expect(fetcher.mock.calls[1][0]).toBe('https://photos.supabase.co/storage/v1/object/farejador-tire-photos');
    expect(fetcher.mock.calls[1][1].method).toBe('DELETE');
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({prefixes:[path]});
  });
});
