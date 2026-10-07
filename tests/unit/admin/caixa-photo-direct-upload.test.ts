import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe,it,expect,vi } from 'vitest';
function setup() {
  const response=(data:unknown)=>({ok:true,json:async()=>data});
  const C={state:{photoDirectUpload:true},sessionFingerprint:()=> 'session-a',
    operationPath:(p:string)=>'/parceiro/loja/api/'+p,json:(r:any)=>r.json(),
    authenticatedFetch:vi.fn(),photoUploadPath:()=>'/legacy',uploadPartnerTirePhoto:undefined as any};
  const fetcher=vi.fn(async(..._args:any[])=>({ok:true}));
  const uuid=vi.fn(()=>'ef0081a8-2eb7-4e36-8e8a-311681d67fbc');
  runInNewContext(readFileSync('painel/public/caixa-partner-photo-upload.js','utf8'),{
    window:{Caixa:C,setTimeout},fetch:fetcher,crypto:{randomUUID:uuid},AbortSignal,
  });
  return {C,fetcher,uuid,response};
}
describe('Upload direto sem transportar a imagem pela API',()=>{
  it('API só recebe UUID; upload assinado não recebe o token do parceiro',async()=>{
    const {C,fetcher,response}=setup();
    C.authenticatedFetch.mockResolvedValueOnce(response({state:'uploading',upload_url:'https://storage.test/signed?token=opaque'}))
      .mockResolvedValueOnce(response({state:'queued'})).mockResolvedValueOnce(response({state:'ready'}));
    const photo={blob:new Blob(['photo'],{type:'image/jpeg'})};
    expect(await C.uploadPartnerTirePhoto('request-1',photo,'session-a')).toEqual({attached:true});
    expect(C.authenticatedFetch.mock.calls.every(call=>!call[1]?.body)).toBe(true);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({method:'PUT',credentials:'omit',referrerPolicy:'no-referrer',body:photo.blob});
    expect(fetcher.mock.calls[0]?.[1].headers).toEqual({'Content-Type':'image/jpeg'});
  });
  it('resposta de finalização perdida: retry consulta o mesmo upload e não repete o PUT',async()=>{
    const {C,fetcher,uuid,response}=setup();const photo={blob:new Blob(['photo'])};
    C.authenticatedFetch.mockResolvedValueOnce(response({state:'uploading',upload_url:'https://storage.test/signed'}))
      .mockRejectedValueOnce(Error('network'));
    await expect(C.uploadPartnerTirePhoto('request-1',photo,'session-a')).rejects.toThrow('network');
    C.authenticatedFetch.mockResolvedValueOnce(response({state:'ready'}));
    expect(await C.uploadPartnerTirePhoto('request-1',photo,'session-a')).toEqual({attached:true});
    expect(uuid).toHaveBeenCalledTimes(1);expect(fetcher).toHaveBeenCalledTimes(1);
    expect(C.authenticatedFetch.mock.calls[0][0]).toBe(C.authenticatedFetch.mock.calls[2][0]);
  });
  it('trocar de sessão durante a reserva impede envio do arquivo',async()=>{
    const {C,fetcher,response}=setup();
    C.authenticatedFetch.mockImplementation(async()=>{C.sessionFingerprint=()=> 'session-b';return response({state:'uploading'});});
    await expect(C.uploadPartnerTirePhoto('request-1',{blob:new Blob(['photo'])},'session-a')).rejects.toThrow('invalid_session');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
