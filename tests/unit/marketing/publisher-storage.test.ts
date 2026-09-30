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
  it('retorna token TUS restrito sem expor a chave administrativa',async()=>{
    fetcher.mockResolvedValue(new Response(JSON.stringify({url:`/object/upload/sign/farejador-publications/${path}?token=scoped`})));
    const session=await new PublisherStorage(fetcher).uploadSession(path);
    expect(session.resumable).toEqual({endpoint:'https://project.supabase.co/storage/v1/upload/resumable',
      token:'scoped',bucket:'farejador-publications',object:path,chunk_size:6291456});
    expect(JSON.stringify(session)).not.toContain('secret-storage');
  });
  it('lê limite e tipos efetivos do bucket sem presumir limite global',async()=>{
    fetcher.mockResolvedValue(new Response(JSON.stringify({public:false,file_size_limit:'52428800',allowed_mime_types:['video/*','image/jpeg']})));
    expect(await new PublisherStorage(fetcher).assertPrivateBucket()).toEqual({maxBytes:52428800,allowedMimes:['video/*','image/jpeg']});
    fetcher.mockResolvedValue(new Response(JSON.stringify({public:false})));
    expect(await new PublisherStorage(fetcher).assertPrivateBucket()).toEqual({maxBytes:null,allowedMimes:null});
  });
  it('a inspeção exige Range real e rejeita respostas completas ou truncadas',async()=>{
    const storage=new PublisherStorage(fetcher);
    fetcher.mockResolvedValue(new Response(new Uint8Array(10),{status:206,headers:{'Content-Range':'bytes 10-19/100'}}));
    expect((await storage.readRange(path,10,19,100)).length).toBe(10);
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({Range:'bytes=10-19'});
    fetcher.mockResolvedValue(new Response(new Uint8Array(100)));
    await expect(storage.readRange(path,10,19,100)).rejects.toThrow('publisher_storage_range_required');
    fetcher.mockResolvedValue(new Response(new Uint8Array(4),{status:206,headers:{'Content-Range':'bytes 10-19/100'}}));
    await expect(storage.readRange(path,10,19,100)).rejects.toThrow('publisher_upload_mismatch');
    await expect(storage.readRange(path,0,100,100)).rejects.toThrow('publisher_media_range_invalid');
  });
});
