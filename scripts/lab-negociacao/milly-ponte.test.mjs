import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import http from 'node:http';

const source = await readFile(new URL('./ponte-milly/pagina.js',import.meta.url),'utf8');
const background = await readFile(new URL('./ponte-milly/background.js',import.meta.url),'utf8');
const origin = 'https://chatgpt.com';
const turn = '44e92d1f-8de4-4196-a5b8-26210d77fd45';
const dotPath = '/dots/4bc57345-52da-4fae-ab70-bfe49ed27745~ficticio';
const prompt = 'FICHA FICTÍCIA, turno ' + turn;
const reply = id => JSON.stringify({turno:id,decisao:'manter',total_centavos:null,modalidade:null,justificativa:'Estoque curto.'});

function fakePage({title='Milly',draft='',moveOnAck=false,ack=true,path=dotPath,verifiedProfile=false,
  bare=false,echo=true,invalid=false,arrowButton=false,sidebarHint}={}) {
  const calls = [], answers = [], url = new URL(origin+path), scheduled = [];
  let listener, clicks=0, leased=false, observerCallback;
  const makeNode = (tag,text='') => ({
    tagName:tag, innerText:text, isConnected:true, dataset:{}, parentElement:null, title:'',
    nodeType:1,childElementCount:0,contains:()=>false, closest:()=>null, getAttribute:()=>null, getClientRects:()=>[{}],
    querySelector:()=>null,querySelectorAll:()=>[],addEventListener(){},removeEventListener(){},focus(){},
    compareDocumentPosition(other){return this.seq<other.seq?4:2;},
  });
  class Textarea {
    get value() {return this._value;}
    set value(s) {this._value=s;}
  }
  const heading = makeNode('H1',title), box=Object.assign(new Textarea(),makeNode('TEXTAREA'),{_value:draft,dispatchEvent(){}});
  if (sidebarHint !== undefined) {
    const pane = makeNode('ASIDE');
    box.closest=selector=>selector==='aside,[role="complementary"]'?pane:null;
    box.getAttribute=key=>key==='placeholder'?sidebarHint:null;
  }
  const controls=makeNode('FORM');
  const button=Object.assign(makeNode('BUTTON',arrowButton?'':'Enviar'),{querySelector:()=>arrowButton?{}:null,click() {
    calls.push('click');clicks++;box.value='';
    if (bare) {
      const newNodes=[];
      if (echo) newNodes.push(Object.assign(makeNode('DIV',prompt),{seq:1}));
      newNodes.push(Object.assign(makeNode('DIV',reply('outro-turno')),{seq:2}));
      const answer = invalid ? JSON.stringify({...JSON.parse(reply(turn)),segredo:'texto indevido'}) : reply(turn);
      newNodes.push(Object.assign(makeNode('DIV',answer),{seq:3}));
      observerCallback([{type:'childList',addedNodes:newNodes}]);return;
    }
    for (const id of ['outro-turno',turn]) answers.push(Object.assign(makeNode('ARTICLE',reply(id)),{dataset:{messageAuthorRole:'assistant'}}));
  }});
  controls.querySelectorAll=()=>[button];box.parentElement=controls;
  answers.push(Object.assign(makeNode('ARTICLE',reply(turn).replace('Estoque curto.','Outro parecer antigo.')),{dataset:{messageAuthorRole:'assistant'}}));
  const document={title,documentElement:makeNode('HTML'),body:makeNode('BODY'),querySelectorAll(query){
    if(query.startsWith('header h1,')) return [heading];
    if(query.startsWith('header a[')) return verifiedProfile ? [Object.assign(heading,{href:origin+dotPath})] : [];
    if(query.startsWith('textarea')) return [box];
    if(query.startsWith('[data-message-author-role=')) return bare?[]:answers;
    return [];
  }};
  const chrome={runtime:{id:'ext',onMessage:{addListener(fn){listener=fn;}},async sendMessage(msg){
    calls.push(msg.type);
    if(msg.type==='proxima') {
      if (leased) return {erro:'fim do teste'};
      leased=true;return {consulta:{turno:turn,prompt}};
    }
    if(msg.type==='recebida'){if(moveOnAck) url.hash='#outra-conversa';return {ok:ack};}
    if(msg.type==='resposta') assert.equal(msg.texto,reply(turn));
    return {ok:true};
  }}};
  const ctx=vm.createContext({document,location:url,chrome,URL,Event:class{},HTMLTextAreaElement:Textarea,Node:{DOCUMENT_POSITION_FOLLOWING:4},
    MutationObserver:class{constructor(callback){observerCallback=callback;}observe(){}disconnect(){}},
    getComputedStyle:()=>({visibility:'visible'}),setTimeout: callback => scheduled.push(callback)});
  const activation=vm.runInContext(source,ctx);
  return {calls,activation,clicks:()=>clicks,
    async run() {
      listener({type:'start'},{id:'ext'},()=>{});
      for(let n=0;n<25;n++) {await new Promise(resolve=>setImmediate(resolve));scheduled.shift()?.();}
    }};
}

test('a ponte verifica o título da Milly e preserva um rascunho prévio', () => {
  assert.equal(fakePage({title:'Outro Dot'}).activation.ok,false);
  assert.equal(fakePage({draft:'rascunho privado'}).activation.ok,false);
  assert.equal(fakePage({title:'Milly',path:'/dots'}).activation.ok,false);
  assert.equal(fakePage({title:'Milly',path:'/dots/qualquer~apelido'}).activation.ok,false);
});
test('uma conversa genérica chamada Milly exige link do Dot no cabeçalho para parear', () => {
  const path='/c/00000000-4000-4000-8000-000000000000';
  assert.equal(fakePage({path}).activation.ok,false);
  assert.equal(fakePage({path,verifiedProfile:true}).activation.ok,true);
});
test('envia uma vez após a reserva e retorna somente a nova resposta desse turno', async () => {
  const p=fakePage();assert.equal(p.activation.ok,true);await p.run();
  assert.deepEqual(p.calls,['proxima','recebida','click','resposta','proxima']);
});
test('identifica o documento da Milly pelo título e rota individual, seta de envio e bolha nova com eco', async () => {
  assert.equal(fakePage({sidebarHint:'Enviar uma mensagem'}).activation.ok,true);
  assert.equal(fakePage({sidebarHint:'Pesquisar'}).activation.ok,false);
  const p=fakePage({bare:true,arrowButton:true});assert.equal(p.activation.ok,true);await p.run();
  assert.deepEqual(p.calls,['proxima','recebida','click','resposta','proxima']);
});
test('recusa bolha sem eco da consulta e JSON com campos alheios', async () => {
  for(const settings of [{echo:false},{invalid:true}]) {
    const p=fakePage({bare:true,...settings});await p.run();
    assert.equal(p.clicks(),1);assert.ok(!p.calls.includes('resposta'));
  }
});
test('troca de conversa durante a reserva ou reserva recusada impede o clique', async () => {
  for(const settings of [{moveOnAck:true},{ack:false}]) {
    const p=fakePage(settings);await p.run();
    assert.equal(p.clicks(),0);assert.ok(p.calls.includes('erro'));assert.ok(!p.calls.includes('resposta'));
  }
});
test('service worker aceita chamadas apenas do documento pareado no frame principal e fixa a origem local',async()=>{
  const requests=[],timeouts=[];let listener;
  const binding={tabId:7,documentId:'doc',url:origin+dotPath,token:'somente-fixture'};
  const chrome={action:{onClicked:{addListener(){}}},storage:{session:{get:async()=>({binding})}},tabs:{onRemoved:{addListener(){}}},
    runtime:{id:'ext',getURL:name=>'chrome-extension://ext/'+name,onMessage:{addListener(fn){listener=fn;}}}};
  vm.runInNewContext(background,{chrome,URL,AbortSignal:{timeout:ms=>{timeouts.push(ms);return AbortSignal.timeout(ms);}},fetch:async(url,opts)=>{
    requests.push({url,opts});return {ok:true,json:async()=>({consulta:null})};
  }});
  const valid={id:'ext',url:binding.url,tab:{id:7},frameId:0,documentId:'doc'};
  const send=(sender,type='proxima')=>new Promise(resolve=>listener({type,turno:turn,texto:reply(turn)},sender,resolve));
  for(const change of [{frameId:1},{documentId:'outra'},{tab:{id:9}},{url:origin+'/c/outra'}]) {
    assert.ok((await send({...valid,...change})).erro);
  }
  assert.ok((await send(valid,'../../qualquer')).erro);
  assert.equal(requests.length,0);
  assert.equal((await send(valid)).consulta,null);
  assert.equal(requests[0].url,'http://127.0.0.1:4328/api/ponte/proxima');
  assert.equal(requests[0].opts.credentials,'omit');
  await send(valid,'resposta');
  assert.deepEqual(timeouts,[6500,150000]);
});

test('clique na aba da Milly abre página privada da extensão e prende o código ao documento que originou o gesto',async()=>{
  const popupUrl='chrome-extension://ext/popup.html',saved={},target={id:11,url:origin+dotPath};
  const control={id:14,url:'about:blank'};
  let clicked,message,docId='dot-original',step='pronta',started=0;
  const chrome={
    runtime:{id:'ext',getURL:()=>popupUrl,onMessage:{addListener(f){message=f;}}},
    action:{onClicked:{addListener(f){clicked=f;}}},
    storage:{session:{get:async key=>({[key]:saved[key]}),set:async items=>Object.assign(saved,items),remove:async key=>delete saved[key]}},
    tabs:{onRemoved:{addListener(){}},get:async id=>id===target.id?target:control,create:async input=>{
      assert.equal(input.url,'about:blank');return control;
    },update:async(id,input)=>{assert.equal(id,control.id);control.url=input.url;return control;},
    sendMessage:async(id,req,scope)=>{
      assert.equal(id,target.id);assert.equal(scope.documentId,docId);
      if (req.type==='start') {started++;return true;}
      if (req.type==='check') return true;
      if (req.type==='diagnostic') return {active:true,stage:step};
    }},
    scripting:{executeScript:async opts=>{assert.equal(opts.target.tabId,target.id);return [{result:{ok:true,stage:'pronta'},documentId:docId}];}},
  };
  vm.runInNewContext(background,{chrome,URL,AbortSignal});
  const ask=(req,sender={url:control.url,tab:{id:control.id},frameId:0})=>
    new Promise(resolve=>message(req,{id:'ext',...sender},resolve));
  await clicked(target);assert.equal(control.url,popupUrl+'?aba=11');
  assert.equal((await ask({type:'status'})).ready,true);
  assert.equal((await ask({type:'status'},{url:control.url,tab:{id:99},frameId:0})).ready,undefined);
  const token='a'.repeat(64);
  assert.equal((await ask({type:'pair',tabId:14,token})).connected,false);assert.equal(started,0);
  assert.equal((await ask({type:'pair',tabId:11,token})).connected,true);assert.equal(started,1);
  step='parecer';assert.equal((await ask({type:'status'})).stage,'parecer');
  step='interna-inesperada';assert.equal((await ask({type:'status'})).stage,'rota');
  assert.equal((await ask({type:'stop'})).connected,false);
  docId='documento-recarregado';
  assert.equal((await ask({type:'pair',tabId:11,token})).connected,false);assert.equal(started,1);
});

test('ponte → HTTP local → sessão retorna 202 antes de o bot concluir e mantém o turno idempotente', async () => {
  Object.assign(process.env, {NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:'postgres://127.0.0.1:1/inerte',
    DATABASE_SSL:'false',CHATWOOT_HMAC_SECRET:'fixture',ADMIN_AUTH_TOKEN:'fixture',OPENAI_API_KEY:'fixture-local'});
  const {register} = await import('tsx/esm/api');
  register();
  const {criarServidor} = await import('./servidor.ts');
  const {laboratorio} = await import('./sessoes.ts');
  let releaseBot, calls=0;
  const botDone = new Promise(resolve=>{releaseBot=resolve;});
  const server = criarServidor(laboratorio(async ({advice})=>{
    calls++;
    assert.deepEqual(advice,{decisao:'manter',total_centavos:null,modalidade:null});
    await botDone;return {text:'Retirada a preço de tabela.',actions:[]};
  }));
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port;
  const local='http://127.0.0.1:4328', ext='chrome-extension://'+'a'.repeat(32);
  function call(method,path,data,token,origin=local) {
    return new Promise((resolve,reject)=>{
      const headers={Host:'127.0.0.1:4328',Origin:origin,'Content-Type':'application/json'};
      if(token) headers.Authorization='Bearer '+token;
      const req=http.request({host:'127.0.0.1',port,path,method,headers},res=>{
        let text='';res.setEncoding('utf8');res.on('data',part=>{text+=part;});
        res.once('end',()=>resolve({status:res.statusCode,data:text?JSON.parse(text):undefined}));
      });
      req.on('error',reject);req.end(data?JSON.stringify(data):undefined);
    });
  }
  try {
    const {codigo}= (await call('POST','/api/pareamento',{})).data;
    const relay=(endpoint,body={})=>call('POST','/api/ponte/'+endpoint,body,codigo,ext);
    assert.equal((await call('POST','/api/ponte/proxima',{},'incorreto',ext)).status,403);
    const s= (await call('POST','/api/sessoes',{cenario:'abundante'})).data;
    const session='/api/sessoes/'+s.id;
    assert.equal((await call('POST',session+'/mensagens',{texto:'Achei caro, faz 80?',consultarMilly:true})).data.estado,'aguardando_milly');
    const consulta=(await relay('proxima')).data.consulta;
    assert.ok(consulta.prompt.includes('Achei caro'));
    assert.equal((await relay('recebida',{turno:consulta.turno})).data.ok,true);
    assert.equal((await relay('proxima')).data.consulta,null);
    const delivered={turno:consulta.turno,texto:reply(consulta.turno)};
    assert.equal((await relay('resposta',delivered)).status,202);
    assert.equal((await call('GET',session)).data.estado,'respondendo');
    assert.equal((await relay('resposta',delivered)).status,409);
    releaseBot();await new Promise(resolve=>setImmediate(resolve));
    const result=(await call('GET',session)).data;
    assert.equal(result.estado,'aberta');
    assert.equal(result.consultas[0].origem,'aba_milly');
    assert.equal(result.mensagens.at(-1).texto,'Retirada a preço de tabela.');
    assert.equal(calls,1);
  } finally { releaseBot();await new Promise(resolve=>server.close(resolve)); }
});
