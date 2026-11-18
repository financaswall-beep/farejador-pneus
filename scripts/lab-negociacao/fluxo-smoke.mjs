import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { register } from 'tsx/esm/api';

Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:'postgres://127.0.0.1:1/teste',
  ADMIN_AUTH_TOKEN:'teste',CHATWOOT_HMAC_SECRET:'teste',OPENAI_API_KEY:'teste-local-sem-valor',OPENAI_MODEL:'gpt-6.1-sol'});
register();
const { laboratorio }=await import('./sessoes.ts');
const { criarServidor }=await import('./servidor.ts');

const chamadas=[];
let liberar;
const lab=laboratorio(async entrada=>{
  chamadas.push(entrada);
  if(entrada.advice) await new Promise(resolve=>{liberar=resolve;});
  return {actions:[],text:'Está R$ 110 na retirada.',toolNames:[],model:'fictício',promptVersion:'teste',durationMs:0,status:'resposta'};
});
const servidor=criarServidor(lab);
servidor.listen(0,'127.0.0.1');await once(servidor,'listening');
const url='http://127.0.0.1:'+servidor.address().port;
const orig='http://127.0.0.1:4328';
async function enviar(path,obj,extras={}){
  // Porta efêmera com o mesmo Host/Origin exigido no laboratório normal.
  return new Promise((resolve,reject)=>{
    const req=request(url+path,{method:obj===undefined?'GET':'POST',
      headers:{host:'127.0.0.1:4328',origin:orig,'Content-Type':'application/json',...extras}},res=>{
        let data='';res.setEncoding('utf8');res.on('data',p=>data+=p);
        res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(data)}));
      });
    req.on('error',reject);req.end(obj===undefined?undefined:JSON.stringify(obj));
  });
}
try {
  const dados=(await enviar('/api/status')).body;
  assert.ok(dados.botConfigurado);assert.equal(dados.cenarios.length,3);
  assert.equal((await enviar('/api/pareamento',{},{origin:'https://example.invalid'})).status,403);
  assert.equal((await enviar('/api/ponte/proxima',{},{})).status,403);
  assert.equal((await enviar('/api/perfil',{opcoes:{OPENAI_API_KEY:'omitida'}})).status,400);
  const s=(await enviar('/api/sessoes',{cenario:'abundante'})).body;
  const path='/api/sessoes/'+s.id;
  assert.equal((await enviar(path+'/mensagens',{texto:'Tem o 110/70-13 para retirar no Centro?'})).body.mensagens.length,2);
  assert.equal((await enviar(path+'/mensagens',{texto:'Achei caro. Faz por 80?'})).body.estado,'aguardando_milly');
  assert.equal(chamadas.length,1);
  const {codigo}=(await enviar('/api/pareamento',{})).body;
  const cab={authorization:'Bearer '+codigo,origin:'chrome-extension://'+'a'.repeat(32)};
  const ponte=(op,obj)=>enviar('/api/ponte/'+op,obj,cab);
  const tarefa=(await ponte('proxima',{})).body.consulta;
  assert.match(tarefa.prompt,/100/);assert.equal((await ponte('proxima',{})).body.consulta,null);
  assert.equal((await ponte('recebida',{turno:tarefa.turno})).status,200);
  assert.equal((await ponte('recebida',{turno:tarefa.turno})).status,409);
  const parecer={turno:tarefa.turno,decisao:'aceitar',total_centavos:8000,modalidade:'retirada',justificativa:'Estoque abundante. Motivo privado.'};
  const retorno=await ponte('resposta',{turno:tarefa.turno,texto:JSON.stringify(parecer)});
  assert.equal(retorno.status,202);
  assert.equal((await enviar(path)).body.estado,'respondendo');
  assert.equal((await enviar(path+'/mensagens',{texto:'Nova mensagem.'})).status,409);
  assert.deepEqual(chamadas[1].advice,{decisao:'aceitar',total_centavos:8000,modalidade:'retirada'});
  assert.ok(!JSON.stringify(chamadas[1].history).includes('Motivo privado'));
  liberar();await new Promise(resolve=>setImmediate(resolve));
  const fim=(await enviar(path)).body;
  assert.equal(fim.estado,'aberta');assert.equal(fim.mensagens.at(-1).texto,'Está R$ 110 na retirada.');
  assert.equal(fim.consultas.at(-1).origem,'aba_milly');
  await enviar(path+'/mensagens',{texto:'Qual é a melhor condição?',consultarMilly:true});
  assert.equal((await enviar(path+'/parecer',{texto:JSON.stringify(parecer)})).status,422);
  assert.equal((await enviar(path+'/sem-parecer',{})).body.estado,'aberta');
  assert.equal((await enviar(path+'/encerrar',{})).status,200);assert.equal((await enviar(path)).status,404);
  console.log('OK • conversa, objeção, parecer privado assíncrono, pareamento, repetição, recusa de turno antigo e modo manual.');
} finally { servidor.close(); }
