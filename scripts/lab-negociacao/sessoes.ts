import { randomUUID } from 'node:crypto';
import { LAB_SCENARIOS, runLabBotTurn, type ChatMessage, type LabAdvice, type LabScenario } from './bot.js';
import { criarConsultaMilly, lerParecerMilly, orientacaoExperimentalMilly } from './milly.js';

type Fala = { papel:'cliente'|'atendente'; texto:string };
type Consulta = {
  turno:string; pergunta:string; resposta?:string; origem?:string;
  fase:'fila'|'reservada'|'enviada'|'manual'|'concluida'; desde:number;
};
type Sessao = {
  id:string; cenario:LabScenario; mensagens:Fala[]; consultas:Consulta[]; historico:ChatMessage[];
  estado:'aberta'|'aguardando_milly'|'respondendo'; atividade:number; erro?:string;
};

export class FalhaLab extends Error {
  constructor(readonly status:number, msg:string) { super(msg); }
}
function falhaBot(causa:unknown) {
  const detalhe = causa instanceof Error ? causa.message : '';
  if (/401|403|API_KEY not set/.test(detalhe)) return 'Confira a chave e o acesso ao modelo na configuração local.';
  if (/429/.test(detalhe)) return 'A API limitou a chamada. Confira o saldo e os limites da chave.';
  if (/404|400/.test(detalhe)) return 'A API rejeitou a chamada. Confira o modelo e as permissões da chave.';
  return 'A chamada da atendente falhou. Confira a conexão e tente novamente.';
}
function objecao(texto:string) {
  const t=texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  return /\b(caro|caros|cara demais|desconto|salgado|salgada|pesado|pesou|contraproposta|negocia\w*|abaixa\w*|baixar|mais barato|melhora\w* (?:o |esse )?(?:preco|valor)|(?:faz|fecha|aceita|fechar|consegue fazer) (?:por |a )?(?:r\$\s*)?\d)/.test(t);
}
const reais=(n:number)=> (n/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
function ficha(c:LabScenario) {
  return [
    'Simulação no Centro, Matriz fictícia. Valores para um pneu novo '+c.medida+'.',
    'Tabela unitária '+reais(c.precoCentavos)+', custo unitário '+reais(c.custoCentavos)+', frete de tabela por pedido '+reais(c.freteCentavos)+'.',
    'Disponíveis '+c.estoque+', giro médio de '+c.giroSemanal+' por semana, reposição em '+c.reposicaoDias+' dias.',
    (c.rotaConfirmada?'Rota já confirmada.':'Entrega exclusiva.')+' Custo incremental da parada '+(c.paradaCentavos===null?'desconhecido':reais(c.paradaCentavos))+'.',
    'O checkout atual só reconhece preço e frete de tabela. Sua proposta será consultiva.',
  ].join('\n');
}
export function laboratorio(gerar=runLabBotTurn) {
  const sessoes=new Map<string,Sessao>();
  const expirar=()=>{
    for(const [id,s] of sessoes) if(s.estado!=='respondendo' && Date.now()-s.atividade>2*60*60_000) sessoes.delete(id);
  };
  const criar=(cenario:string)=>{
    expirar();
    const c=LAB_SCENARIOS.find(item=>item.id===cenario);
    if(!c) throw new FalhaLab(400,'Escolha um dos cenários do laboratório.');
    if(sessoes.size>=32) throw new FalhaLab(429,'Limite de testes abertos neste servidor.');
    const s:Sessao={id:randomUUID(),cenario:c,mensagens:[],consultas:[],historico:[],estado:'aberta',atividade:Date.now()};
    sessoes.set(s.id,s); return s;
  };
  const obter=(id:string)=>{
    expirar();
    const s=sessoes.get(id);
    if(!s) throw new FalhaLab(404,'Teste encerrado. Inicie outro cenário.');
    return s;
  };
  const pendente=(s:Sessao)=>{
    const q=s.consultas.at(-1);
    if(s.estado!=='aguardando_milly'||!q||q.fase==='concluida') throw new FalhaLab(409,'Este turno já foi atendido.');
    return q;
  };
  const publico=(s:Sessao)=>({id:s.id,cenario:s.cenario.id,mensagens:s.mensagens,
    consultas:s.consultas.map(({pergunta,resposta,origem,fase})=>({pergunta,resposta,origem,fase})),estado:s.estado,erro:s.erro});
  async function responder(s:Sessao,advice?:LabAdvice) {
    s.estado='respondendo'; s.erro=undefined;
    const result=await gerar({history:s.historico,scenario:s.cenario,advice});
    s.historico.push(...result.actions);
    if(result.text) {
      s.historico.push({role:'assistant',content:result.text});
      s.mensagens.push({papel:'atendente',texto:result.text});
    } else s.erro='A regra da atendente suprimiu uma resposta repetida neste turno.';
    s.estado='aberta';s.atividade=Date.now();
  }
  async function mensagem(s:Sessao,texto:string,consultar:boolean) {
    if(s.estado!=='aberta') throw new FalhaLab(409,'Conclua o turno atual.');
    if(s.mensagens.length>=80) throw new FalhaLab(400,'Este teste chegou ao limite. Inicie outra conversa.');
    s.atividade=Date.now();s.erro=undefined;
    s.mensagens.push({papel:'cliente',texto});s.historico.push({role:'user',content:texto});
    try {
      if(consultar||objecao(texto)) {
        const turno=randomUUID();
        const consulta=criarConsultaMilly({turno,contextoFicticio:ficha(s.cenario),
          mensagens:s.mensagens.slice(-12).map(m=>({role:m.papel==='cliente'?'user':'assistant',content:m.texto}))});
        s.consultas.push({turno,pergunta:consulta.prompt,fase:'fila',desde:Date.now()});
        s.estado='aguardando_milly';
      } else await responder(s);
    } catch(e) {
      s.historico.pop();s.mensagens.pop();s.estado='aberta';
      throw new FalhaLab(502,falhaBot(e));
    }
    return publico(s);
  }
  function parecer(s:Sessao,texto?:string,origem='manual') {
    const q=pendente(s);
    let decisao:LabAdvice|undefined;
    if(texto) {
      try {decisao=orientacaoExperimentalMilly(lerParecerMilly(q.turno,texto));}
      catch {throw new FalhaLab(422,'Cole o parecer completo com o JSON e o identificador deste turno.');}
      q.resposta=texto;
    } else q.resposta=undefined;
    q.origem=texto?origem:'dispensada';
    q.fase='manual';
    return responder(s,decisao).then(()=>{
      q.fase='concluida';return publico(s);
    }).catch(e=>{
      s.estado='aguardando_milly';s.erro=falhaBot(e);throw new FalhaLab(502,s.erro);
    });
  }
  function proxima() {
    expirar();
    for(const s of sessoes.values()){
      if(s.estado!=='aguardando_milly') continue;
      const q=pendente(s);
      if(q.fase==='enviada' && Date.now()-q.desde>180_000) {q.fase='manual';s.erro='O retorno da ponte demorou. Você pode colar a resposta da Milly.';}
      if(q.fase==='fila'||(q.fase==='reservada'&&Date.now()-q.desde>15_000)){
        q.fase='reservada';q.desde=Date.now();return {turno:q.turno,prompt:q.pergunta};
      }
    }
    return null;
  }
  function daPonte(turno:string) {
    for(const s of sessoes.values()){
      if(s.estado==='aguardando_milly'&&s.consultas.at(-1)?.turno===turno) return {s,q:pendente(s)};
    }
    throw new FalhaLab(409,'Esta consulta da ponte terminou.');
  }
  return { criar,obter,publico,mensagem,parecer,proxima,daPonte,
    ocupado:()=>[...sessoes.values()].some(s=>s.estado==='respondendo'),
    fechar(id:string){const s=obter(id);if(s.estado==='respondendo') throw new FalhaLab(409,'Aguarde a resposta em andamento.');sessoes.delete(id);}
  };
}
