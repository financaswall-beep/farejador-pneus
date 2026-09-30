import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { randomUUID, webcrypto } from 'node:crypto';

const endpoint='https://example.storage.supabase.co/storage/v1/upload/resumable/sign';
const chunk=6*1024*1024;
const reservation={id:'media-id',resumable:{endpoint,token:'signed-token',bucket:'publisher',object:'test/media-id/original.mp4',chunk_size:chunk}};
type Request={method:string;url:string;headers:Record<string,string>;bytes:number};

function browser(initialOffset=0,losePatch=false,stored=new Map<string,string>()) {
  const requests:Request[]=[];
  let offset=initialOffset;
  let length=0;
  let interrupted=false;
  const localStorage={getItem:(key:string)=>stored.get(key)||null,setItem:(key:string,value:string)=>stored.set(key,value),removeItem:(key:string)=>stored.delete(key)};
  class Xhr {
    upload={onprogress:null as any}; headers:Record<string,string>={}; responseHeaders:Record<string,string>={};
    method='';url='';status=0;responseText='';withCredentials=false;onload:any;onerror:any;
    open(method:string,url:string){this.method=method;this.url=url;}
    setRequestHeader(key:string,value:string){this.headers[key]=value;}
    getResponseHeader(key:string){return this.responseHeaders[key.toLowerCase()]??null;}
    abort(){return undefined;}
    send(body?:Blob){
      const bytes=body?.size||0;
      requests.push({method:this.method,url:this.url,headers:{...this.headers},bytes});
      queueMicrotask(()=>{
        if(this.method==='POST'){
          if(new URL(this.url).pathname!=='/storage/v1/upload/resumable/sign'){
            this.status=401;this.onload();return;
          }
          length=Number(this.headers['Upload-Length']);offset=bytes;this.status=201;
          this.responseHeaders={location:endpoint+'/session','upload-offset':String(offset)};
        }else if(this.method==='HEAD'){
          this.status=200;this.responseHeaders={'upload-offset':String(offset),'upload-length':String(length)};
        }else if(this.method==='PATCH'){
          if(Number(this.headers['Upload-Offset'])!==offset){this.status=409;this.onload();return;}
          offset+=bytes;this.status=204;this.responseHeaders={'upload-offset':String(offset)};
          if(losePatch&&!interrupted){interrupted=true;this.onerror(new Error('resposta perdida'));return;}
        }
        this.upload.onprogress?.({loaded:bytes,lengthComputable:true});this.onload();
      });
    }
  }
  const window:any={MARKETING_PUBLISHER_TEMPLATE:'static',confirm:()=>true,lucide:{createIcons:()=>undefined}};
  const context=createContext({window,XMLHttpRequest:Xhr,localStorage,navigator:{onLine:true},Blob,File,URL,TextEncoder,Uint8Array,
    crypto:{randomUUID,subtle:webcrypto.subtle},setTimeout,clearTimeout,Intl,Date,console});
  runInContext(readFileSync('painel/public/vendor/publisher-tus-4.3.1.min.js','utf8'),context);
  window.PublisherTus=(context as any).PublisherTus;
  for(const path of ['helpers','media'])runInContext(readFileSync('painel/public/app.marketing.publisher.'+path+'.js','utf8'),context);
  runInContext(readFileSync('painel/public/app.marketing.publisher.js','utf8'),context);
  const state:any={...window.PAINEL_MODULES.marketingPublisher(),...window.PAINEL_MODULES.marketingPublisherMedia()};
  state.$nextTick=(callback:()=>void)=>callback();state.mpFresh();state.mpConfig={enabled:true,storage_ready:true,max_file_bytes:500*1024*1024};
  state.apiPost=vi.fn().mockResolvedValue(reservation);state.mpLoad=vi.fn().mockResolvedValue(undefined);
  return {state,requests,stored,setLength:(value:number)=>{length=value;},offset:()=>offset};
}

it('cliente TUS real recupera PATCH aceito com resposta perdida via HEAD, sem duplicar bytes',async()=>{
  const b=browser(0,true);const file=new File([new Uint8Array(chunk*2+200)],'iphone.mov',{type:'video/quicktime',lastModified:1});
  await b.state.mpResumableUpload(reservation,file,file.type,'fingerprint');
  expect(b.offset()).toBe(file.size);
  expect(b.requests.filter(r=>r.method==='PATCH').map(r=>r.headers['Upload-Offset'])).toEqual([String(chunk),String(chunk*2)]);
  expect(b.requests.some(r=>r.method==='HEAD')).toBe(true);
  expect(b.requests.every(r=>r.bytes<=chunk)).toBe(true);
  expect(b.requests.every(r=>r.headers['x-signature']==='signed-token'&&!r.headers.Authorization&&!r.headers.apikey)).toBe(true);
  expect(b.requests[0]?.url).toBe(endpoint);
  expect([...b.stored.values()].join()).not.toContain('signed-token');
});
it('reabre uma sessão interrompida com token renovado e envia somente os bytes restantes',async()=>{
  const b=browser(chunk);const file=new File([new Uint8Array(chunk+100)],'iphone.mov',{type:'video/quicktime',lastModified:1});
  b.setLength(file.size);b.state.mpStoreUploadSession('media-id',{url:endpoint+'/session',fingerprint:'same'});
  await b.state.mpResumableUpload({...reservation,resumable:{...reservation.resumable,token:'renewed-token'}},file,file.type,'same');
  expect(b.requests.map(r=>r.method)).toEqual(['HEAD','PATCH']);expect(b.requests[1]?.bytes).toBe(100);
  expect(b.requests.every(r=>r.headers['x-signature']==='renewed-token')).toBe(true);
});
it('reprocessa arquivo recebido após falha de conferência sem repetir o upload',async()=>{
  const b=browser();b.state.mpStoreUploadSession('media-id',{url:endpoint+'/session',fingerprint:'same',complete:true});
  b.state.apiPost.mockRejectedValueOnce(Error('publisher_media_processing_busy')).mockResolvedValueOnce({id:'media-id'});
  await b.state.mpReprocessMedia({id:'media-id',name:'iphone.mov'});
  expect(b.state.mpReadUploadSession('media-id').complete).toBe(true);
  await b.state.mpReprocessMedia({id:'media-id',name:'iphone.mov'});
  expect(b.state.apiPost.mock.calls).toEqual([['/admin/api/marketing/publisher/media/media-id/complete',{}],['/admin/api/marketing/publisher/media/media-id/complete',{}]]);
  expect(b.requests).toHaveLength(0);expect(b.state.mpReadUploadSession('media-id')).toBe(null);
});
it('HEIC sem MIME do navegador pode ser enviado e a conferência usa metadados do servidor',async()=>{
  const b=browser();const file=new File([new Uint8Array(10)],'foto.HEIC',{lastModified:1});
  b.state.mpResumableUpload=vi.fn().mockResolvedValue(undefined);
  await b.state.mpUploadFiles({target:{files:[file],value:'foto.HEIC'}});
  expect(b.state.apiPost.mock.calls[0]?.[1]).toMatchObject({name:'foto.HEIC',mime:'image/heic',bytes:10});
  expect(b.state.apiPost.mock.calls[1]?.[1]).toEqual({});expect(b.state.mpError).toBe('');
});
it('não envia token para URL de retomada adulterada ou arquivo diferente',async()=>{
  const b=browser();const file=new File(['video'],'iphone.mov',{type:'video/quicktime'});
  b.state.mpStoreUploadSession('media-id',{url:'https://outside.invalid/session',fingerprint:'same'});
  await expect(b.state.mpResumableUpload(reservation,file,file.type,'same')).rejects.toThrow('publisher_upload_failed');
  b.state.mpStoreUploadSession('media-id',{url:endpoint+'/session',fingerprint:'other'});
  await expect(b.state.mpResumableUpload(reservation,file,file.type,'same')).rejects.toThrow('publisher_resume_mismatch');
  expect(b.requests).toHaveLength(0);
});
it('retomada exige exatamente o arquivo reservado e o modo demonstrativo não faz upload',async()=>{
  const b=browser();const file=new File(['video'],'changed.mov',{type:'video/quicktime'});
  await b.state.mpUploadFiles({target:{files:[file]}},{id:'media-id',name:'iphone.mov',mime:file.type,bytes:file.size});
  expect(b.state.apiPost).not.toHaveBeenCalled();expect(b.state.mpError).toContain('mesmo arquivo');
  b.state.marketingIsMock=()=>true;await b.state.mpUploadFiles({target:{files:[file]}});
  expect(b.state.apiPost).not.toHaveBeenCalled();expect(b.requests).toHaveLength(0);
});
it('limite de bucket menor que 8 MB é respeitado antes de reservar uma foto',async()=>{
  const b=browser();b.state.mpConfig.max_file_bytes=1024;
  const file=new File([new Uint8Array(1025)],'foto.jpg',{type:'image/jpeg'});
  await b.state.mpUploadFiles({target:{files:[file]}});
  expect(b.state.apiPost).not.toHaveBeenCalled();expect(b.state.mpError).toContain('limite');
});
it('selecionar novamente arquivo completo com falha reutiliza reserva e não acessa URL TUS expirada',async()=>{
  const b=browser();const file=new File(['video'],'iphone.mov',{type:'video/quicktime',lastModified:1});
  const fingerprint=await b.state.mpFileFingerprint(file);
  b.state.mpStoreUploadSession('media-id',{url:endpoint+'/expired',fingerprint,complete:true});
  b.state.mpMedia=[{id:'media-id',name:file.name,mime:file.type,bytes:file.size,status:'failed'}];
  await b.state.mpUploadFiles({target:{files:[file]}});
  expect(b.state.apiPost.mock.calls[0]?.[1].id).toBe('media-id');
  expect(b.state.apiPost.mock.calls[1]?.[0]).toBe('/admin/api/marketing/publisher/media/media-id/complete');
  expect(b.requests).toHaveLength(0);
});
it('reserva confirma arquivo já recebido e pula upload mesmo sem sessão no navegador',async()=>{
  const b=browser();const file=new File(['video'],'iphone.mov',{type:'video/quicktime'});
  b.state.apiPost.mockResolvedValue({...reservation,already_uploaded:true});
  await b.state.mpUploadFiles({target:{files:[file]}},{id:'media-id',name:file.name,mime:file.type,bytes:file.size,status:'uploading'});
  expect(b.state.apiPost.mock.calls[0]?.[1].id).toBe('media-id');expect(b.requests).toHaveLength(0);
});
it('objeto ausente limpa estado completo local e permite continuar o envio',async()=>{
  const b=browser();b.state.mpStoreUploadSession('media-id',{url:endpoint+'/expired',fingerprint:'same',complete:true});
  b.state.apiPost.mockRejectedValue(Error('publisher_storage_object_missing'));
  await b.state.mpReprocessMedia({id:'media-id',name:'iphone.mov'});
  expect(b.state.mpReadUploadSession('media-id')).toBe(null);
});
