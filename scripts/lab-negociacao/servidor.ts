import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { configureLabBot, configureLabProfile, labBotInfo, LAB_SCENARIOS } from './bot.js';
import { FalhaLab, laboratorio } from './sessoes.js';

const porta=4328;
const origem='http://127.0.0.1:'+porta;
const pastaPonte=fileURLToPath(new URL('./ponte-milly/',import.meta.url));
const origemExtensao=/^chrome-extension:\/\/[a-p]{32}$/;
const csp="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

function json(res:ServerResponse,valor:unknown,status=200) {
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(valor));
}
async function corpo(req:IncomingMessage) {
  if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']??'')) throw new FalhaLab(415,'Envie JSON.');
  const partes:Buffer[]=[];let tamanho=0;
  for await(const p of req){
    tamanho+=p.length;
    if(tamanho>32_768) throw new FalhaLab(413,'Texto muito longo.');
    partes.push(Buffer.from(p));
  }
  try {
    const obj=JSON.parse(Buffer.concat(partes).toString());
    if(typeof obj==='object' && obj!==null && !Array.isArray(obj)) return obj as Record<string,unknown>;
  } catch {}
  throw new FalhaLab(400,'O conteúdo da requisição é inválido.');
}
function texto(v:unknown,max:number) {
  if(typeof v!=='string'||v.trim().length===0||v.length>max) throw new FalhaLab(400,'Confira o tamanho do texto enviado.');
  return v.trim();
}
export function criarServidor(lab=laboratorio()) {
  let codigo:string|undefined,ultimoContato=0,perfil:'padrao_repositorio'|'configurado'='padrao_repositorio';
  function status(){
    const bot=labBotInfo(),ponteAtiva=Date.now()-ultimoContato<45_000;
    return {botConfigurado:bot.keyConfigured,modelo:bot.model,versaoPrompt:bot.promptVersion,flags:bot.flags,perfil,
      milly:ponteAtiva?'ponte_navegador':'ponte_manual',ponteAtiva,cenarios:LAB_SCENARIOS.map(s=>({id:s.id,nome:s.nome+' · '+s.medida+' · Centro'}))};
  }
  function autenticar(req:IncomingMessage) {
    const entrada=Buffer.from(req.headers.authorization??''),esperado=Buffer.from('Bearer '+codigo);
    if(!codigo||entrada.length!==esperado.length||!timingSafeEqual(entrada,esperado)) throw new FalhaLab(403,'Confira o código de pareamento.');
    ultimoContato=Date.now();
  }
  return createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    try {
      if(req.headers.host!=='127.0.0.1:'+porta) throw new FalhaLab(403,'Abra o endereço local do laboratório.');
      const rota=req.url??'',metodo=req.method;
      const ponte=rota.startsWith('/api/ponte/');
      if(ponte){
        if(req.headers.origin && !origemExtensao.test(req.headers.origin) && req.headers.origin!==origem) throw new FalhaLab(403,'Origem da ponte inválida.');
        if(req.headers.origin && origemExtensao.test(req.headers.origin)){
          res.setHeader('Access-Control-Allow-Origin',req.headers.origin);res.setHeader('Vary','Origin');
          res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
        }
        if(metodo==='OPTIONS'){res.writeHead(204);res.end();return;}
        autenticar(req);
      } else if((req.headers.origin && req.headers.origin!==origem) || (metodo!=='GET' && req.headers.origin!==origem)){
        throw new FalhaLab(403,'Abra o laboratório nesta máquina.');
      }
      if(metodo==='GET'){
        if(rota==='/'){
          const html=await readFile(new URL('./index.html',import.meta.url));
          res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':csp});res.end(html);return;
        }
        if(rota==='/api/status') return json(res,status());
        const match=/^\/api\/sessoes\/([\da-f-]{36})$/.exec(rota);
        if(match) return json(res,lab.publico(lab.obter(match[1]!)));
      } else if(metodo==='POST') {
        const p=await corpo(req);
        if(rota==='/api/configurar'){
          if(lab.ocupado()) throw new FalhaLab(409,'Aguarde a chamada da API em andamento.');
          try{configureLabBot(texto(p.chave,2048),p.modelo===undefined?undefined:texto(p.modelo,128));}
          catch {throw new FalhaLab(400,'Confira o formato da chave e do modelo.');}
          return json(res,status());
        }
        if(rota==='/api/pareamento'){
          codigo=randomBytes(32).toString('hex');ultimoContato=0;
          return json(res,{codigo,pasta:pastaPonte});
        }
        if(rota==='/api/perfil'){
          if(lab.ocupado()) throw new FalhaLab(409,'Aguarde o término da chamada da atendente.');
          try {configureLabProfile(p.opcoes);} catch {throw new FalhaLab(400,'Confira as sete opções da instalação no guia do laboratório.');}
          perfil='configurado';return json(res,status());
        }
        if(rota==='/api/ponte/proxima') return json(res,{consulta:lab.proxima()});
        if(ponte){
          const {s,q}=lab.daPonte(texto(p.turno,60));
          if(rota==='/api/ponte/recebida' && q.fase==='reservada') {q.fase='enviada';q.desde=Date.now();return json(res,{ok:true});}
          if(rota==='/api/ponte/erro' && ['enviada','reservada'].includes(q.fase)){
            q.fase='manual';s.erro='A ponte parou. Confira a aba da Milly ou cole o parecer neste turno.';return json(res,{ok:true});
          }
          if(rota==='/api/ponte/resposta' && q.fase==='enviada'){
            try {
              // A validação do turno é síncrona. A página acompanha a chamada da atendente por polling.
              void lab.parecer(s,texto(p.texto,8000),'aba_milly').catch(()=>{ /* erro já disponível na sessão */ });
            }
            catch(e) {
              if(s.estado==='aguardando_milly' && q.fase==='enviada') {
                q.fase='manual';s.erro='Confira o parecer na aba da Milly e cole a resposta completa.';
              }
              throw e;
            }
            return json(res,{ok:true},202);
          }
          throw new FalhaLab(409,'Esta consulta não está mais disponível para a ponte.');
        }
        if(rota==='/api/sessoes') return json(res,lab.publico(lab.criar(texto(p.cenario,80))));
        const match=/^\/api\/sessoes\/([\da-f-]{36})\/(mensagens|parecer|sem-parecer|encerrar)$/.exec(rota);
        if(match){
          const s=lab.obter(match[1]!);
          if(match[2]==='encerrar'){lab.fechar(s.id);return json(res,{ok:true});}
          if(!labBotInfo().keyConfigured) throw new FalhaLab(409,'Conecte a API do bot no campo de configuração deste laboratório.');
          if(match[2]==='mensagens') return json(res,await lab.mensagem(s,texto(p.texto,1500),p.consultarMilly===true));
          return json(res,await lab.parecer(s,match[2]==='parecer'?texto(p.texto,16_000):undefined));
        }
      }
      throw new FalhaLab(404,'Recurso não encontrado.');
    } catch(e) {
      const erro=e instanceof FalhaLab?e:new FalhaLab(500,'O laboratório não conseguiu concluir a operação.');
      json(res,{erro:erro.message},erro.status);
    }
  });
}
export async function iniciar() {
  const server=criarServidor();
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(porta,'127.0.0.1',resolve);});
  console.log('Laboratório de negociação em '+origem);
}
