import { beforeEach,describe,it,expect,vi } from 'vitest';
vi.mock('../../../src/shared/config/env.js',()=>({env:{SUPABASE_STORAGE_URL:'https://project.supabase.co',SUPABASE_STORAGE_SERVICE_KEY:'secret-storage',MARKETING_PUBLICATIONS_BUCKET:'farejador-publications'}}));
import { PublisherStorage } from '../../../src/marketing/publisher/storage.js';
const path='test/ad5e2be8-2725-4a4f-96a6-c77aceecdc80/original.mp4';
const fetcher=vi.fn<typeof fetch>();
beforeEach(()=>fetcher.mockReset());
describe('Storage privado: limites e credenciais',()=>{
  it('não expõe chave e aceita URL de upload somente para o objeto autorizado',async()=>{
    fetcher.mockResolvedValue(new Response(JSON.stringify({url:`/object/upload/sign/farejador-publications/${path}?token=limited-token`})));
    const url=await new PublisherStorage(fetcher).uploadUrl(path);
    expect(url).toContain('limited-token');expect(url).not.toContain('secret-storage');
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({Authorization:'Bearer secret-storage'});
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe('error');
  });
  it('rejeita URL estrangeira, caminho fora do objeto e bucket público',async()=>{
    const storage=new PublisherStorage(fetcher);
    fetcher.mockResolvedValue(new Response(JSON.stringify({url:'https://evil.test/leak'})));
    await expect(storage.uploadUrl(path)).rejects.toThrow('publisher_storage_response');
    await expect(storage.uploadUrl('../private')).rejects.toThrow('publisher_storage_path');
    fetcher.mockResolvedValue(new Response(JSON.stringify({public:true})));
    await expect(storage.assertPrivateBucket()).rejects.toThrow('publisher_bucket_must_be_private');
  });
  it('limita leitura de imagem e não baixa um vídeo inteiro quando Range é ignorado',async()=>{
    const storage=new PublisherStorage(fetcher);
    fetcher.mockResolvedValue(new Response(new Uint8Array(100)));
    await expect(storage.read(path,32,false)).rejects.toThrow('publisher_media_too_large');
    fetcher.mockResolvedValue(new Response(new Uint8Array(100)));
    expect((await storage.read(path,32,true)).length).toBe(32);
    expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({Range:'bytes=0-31'});
  });
  it('remove apenas caminhos validados e sanitiza falhas externas',async()=>{
    fetcher.mockResolvedValue(new Response('sensitive provider details',{status:500}));
    await expect(new PublisherStorage(fetcher).remove([path])).rejects.toThrow('publisher_storage_rejected');
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({prefixes:[path]});
  });
});
