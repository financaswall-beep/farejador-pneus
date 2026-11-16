import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks=vi.hoisted(()=>({lookup:vi.fn(),get:vi.fn()}));
vi.mock('node:dns/promises',()=>({lookup:mocks.lookup}));
vi.mock('node:https',()=>({get:mocks.get,request:vi.fn()}));
import { downloadPublisherFile } from '../../../src/admin/dot/publisher-download.js';

const dirs:string[]=[];
afterEach(async()=>{
  vi.resetAllMocks();
  await Promise.all(dirs.splice(0).map(dir=>rm(dir,{recursive:true,force:true})));
});
async function output() {
  const dir=await mkdtemp(join(tmpdir(),'test-publisher-file-'));dirs.push(dir);return join(dir,'source');
}
function response(status:number,headers:Record<string,string>,body:Buffer) {
  return Object.assign(Readable.from([body]),{statusCode:status,headers});
}
it('segue a URL temporária do anexo e grava o tamanho e tipo reais',async()=>{
  const payload=Buffer.from('photo fixture');
  mocks.lookup.mockResolvedValue([{family:4,address:'93.184.216.34'}]);
  const responses=[response(302,{location:'https://media.example/foto'},Buffer.from('')),
    response(200,{'content-type':'image/jpeg','content-length':String(payload.length)},payload)];
  mocks.get.mockImplementation((_url,_options,callback)=>{callback(responses.shift());return new EventEmitter();});
  const file=await output();
  expect(await downloadPublisherFile('https://files.example/source',file,100)).toEqual({bytes:payload.length,mime:'image/jpeg'});
  expect(await readFile(file)).toEqual(payload);expect(mocks.lookup.mock.calls.map(c=>c[0])).toEqual(['files.example','media.example']);
});
it('limita o download mesmo quando o servidor omite o tamanho',async()=>{
  mocks.lookup.mockResolvedValue([{family:4,address:'93.184.216.34'}]);
  mocks.get.mockImplementation((_url,_options,callback)=>{callback(response(200,{},Buffer.alloc(32)));return new EventEmitter();});
  await expect(downloadPublisherFile('https://files.example/video',await output(),16)).rejects.toThrow('publisher_media_too_large');
});
