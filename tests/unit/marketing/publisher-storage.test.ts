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
    expect(session.resumable).toEqual({endpoint:'https://project.supabase.co/storage/v1/upload/resumable/sign',
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

describe('Contrato real de consulta do Storage', () => {
  const missing = { statusCode: '404', code: 'NoSuchKey', error: 'not_found', message: 'Object not found' };

  it('reconhece NoSuchKey lógico 404 entregue em HTTP 400 nas leituras de objeto', async () => {
    const storage = new PublisherStorage(fetcher);
    const lookups = [
      () => storage.info(path),
      () => storage.read(path, 32),
      () => storage.readRange(path, 0, 31, 100),
    ];
    for (const lookup of lookups) {
      fetcher.mockResolvedValueOnce(new Response(JSON.stringify(missing), { status: 400 }));
      await expect(lookup()).rejects.toMatchObject({
        code: 'publisher_storage_object_missing', status: 404, message: 'publisher_storage_object_missing',
      });
    }
  });

  it.each([400, 404])('preserva o erro legado explícito de objeto ausente em HTTP %i', async status => {
    fetcher.mockResolvedValue(new Response(JSON.stringify({ statusCode: '404', error: 'not_found' }), { status }));
    await expect(new PublisherStorage(fetcher).info(path)).rejects.toMatchObject({
      code: 'publisher_storage_object_missing', status: 404,
    });
  });

  it('aceita status lógico numérico no contrato moderno', async () => {
    fetcher.mockResolvedValue(new Response(JSON.stringify({ ...missing, statusCode: 404 }), { status: 404 }));
    await expect(new PublisherStorage(fetcher).info(path)).rejects.toThrow('publisher_storage_object_missing');
  });

  it.each([
    { status: 400, code: 'NoSuchBucket', logical: '404' },
    { status: 404, code: 'NoSuchBucket', logical: '404' },
    { status: 400, code: 'NoSuchUpload', logical: '404' },
    { status: 400, code: 'InvalidJWT', logical: '400' },
    { status: 400, code: 'AccessDenied', logical: '403' },
    { status: 403, code: 'NoSuchKey', logical: '404' },
    { status: 500, code: 'NoSuchKey', logical: '404' },
    { status: 400, code: 'NoSuchKey', logical: '400' },
  ])('não considera $code / HTTP $status como ausência sem confirmação de leitura', async row => {
    fetcher.mockResolvedValue(new Response(JSON.stringify({
      code: row.code, statusCode: row.logical, error: 'not_found', message: 'sensitive provider details',
    }), { status: row.status }));
    await expect(new PublisherStorage(fetcher).info(path)).rejects.toMatchObject({
      code: 'publisher_storage_rejected', status: 502, message: 'publisher_storage_rejected',
    });
  });

  it('não aplica a classificação de ausência em bucket, assinatura, escrita ou remoção', async () => {
    const storage = new PublisherStorage(fetcher);
    const operations = [
      () => storage.assertPrivateBucket(),
      () => storage.uploadSession(path),
      () => storage.signedUrl(path),
      () => storage.put(path, Buffer.from('photo')),
      () => storage.remove([path]),
    ];
    for (const operation of operations) {
      fetcher.mockResolvedValueOnce(new Response(JSON.stringify(missing), { status: 404 }));
      await expect(operation()).rejects.toThrow('publisher_storage_rejected');
    }
  });

  it.each(['<html>Gateway not found</html>', '{bad json', 'null', '[]', '{}'])(
    'sanitiza corpo inválido HTTP 404 sem presumir objeto ausente: %s', async body => {
      fetcher.mockResolvedValue(new Response(body, { status: 404 }));
      await expect(new PublisherStorage(fetcher).info(path)).rejects.toThrow('publisher_storage_rejected');
    },
  );

  it('limita o corpo do erro a 8 KiB e cancela o stream sem aceitar seu prefixo', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const payload = JSON.stringify({ ...missing, message: 'sensitive '.repeat(1000) });
        controller.enqueue(new TextEncoder().encode(payload));
      },
      cancel,
    });
    fetcher.mockResolvedValue(new Response(body, { status: 400 }));
    const failure = await new PublisherStorage(fetcher).info(path).catch(error => error);
    expect(failure).toMatchObject({ code: 'publisher_storage_rejected', message: 'publisher_storage_rejected' });
    expect(String(failure)).not.toContain('sensitive');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('não transforma falha de rede ou leitura interrompida em objeto ausente', async () => {
    fetcher.mockRejectedValueOnce(new Error('secret URL or token'));
    await expect(new PublisherStorage(fetcher).info(path)).rejects.toMatchObject({
      code: 'publisher_storage_unavailable', message: 'publisher_storage_unavailable',
    });
    fetcher.mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.error(new Error('sensitive provider details')); },
    }), { status: 400 }));
    await expect(new PublisherStorage(fetcher).info(path)).rejects.toThrow('publisher_storage_rejected');
  });

  it('usa tamanho e MIME reais e ignora metadata manipulável do usuário', async () => {
    fetcher.mockResolvedValue(new Response(JSON.stringify({
      size: 2_737_825, content_type: 'image/png', metadata: { size: 1, mimetype: 'video/mp4' },
    })));
    await expect(new PublisherStorage(fetcher).info(path)).resolves.toEqual({ bytes: 2_737_825, mime: 'image/png' });
  });

  it.each([
    { metadata: { size: 100, mimetype: 'image/png' } },
    { size: null, content_type: 'image/png', metadata: { size: 100 } },
    { size: true, content_type: 'image/png' },
    { size: 100, content_type: null, metadata: { mimetype: 'image/png' } },
  ])('rejeita resposta sem tamanho/MIME superiores válidos: %j', async data => {
    fetcher.mockResolvedValue(new Response(JSON.stringify(data)));
    await expect(new PublisherStorage(fetcher).info(path)).rejects.toThrow('publisher_storage_response');
  });
});
