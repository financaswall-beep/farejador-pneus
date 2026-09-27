import {beforeEach,it,expect,vi} from 'vitest';
const flags=vi.hoisted(()=>({ORGANIC_ATTRIBUTION_ENABLED:true,BOT_AUDIO_ENABLED:true,BOT_OUTBOX:true,
  AGENT_V2_WORKER_ENABLED:true,META_MESSAGING_WEBHOOK_ENABLED:true,FAREJADOR_ENV:'prod',
  OPENAI_API_KEY:'test',AGENT_V2_CONVERSATION_IDS:['*'],
  ORGANIC_INSTAGRAM_PRIVATE_ENABLED:true,ORGANIC_FACEBOOK_PRIVATE_ENABLED:false}));
vi.mock('../../../src/shared/config/env.js',()=>({env:flags}));
import {sendOrganicPrivate} from '../../../src/marketing/organic/outreach.js';
import {MetaCommentError} from '../../../src/social-comments/graph.js';
const task:any={id:'comment-uuid',decision_id:'decision',platform:'instagram',account_id:'17841465774227389',comment_id:'123',author_id:'55'};
function database(busy=false) {
  let state:string|null=null;
  const trace:string[]=[];
  const query=vi.fn(async(sql:string,params:any[]=[])=>{
    trace.push(sql);
    if(sql.startsWith('SELECT status FROM'))return {rows:state?[{status:state}]:[],rowCount:state?1:0};
    if(sql.startsWith('SELECT d.*'))return {rows:[{action:'reply',commercial_intent:true,confidence_level:'high',
      occurred_at:new Date(Date.now()-1000),activated_at:new Date(Date.now()-10000),removed:false,
      private_body:'Preço errado R$ 900,00',commercial_snapshot:[{result:{produtos:[{medida:'90/90-12',condicao:'meia_vida',disponivel:true,preco:89,moeda:'BRL'}]}}]}],rowCount:1};
    if(sql.startsWith('SELECT 1 FROM ops.organic_outreach'))return {rows:busy?[{}]:[],rowCount:busy?1:0};
    if(sql.startsWith('INSERT INTO ops.organic_outreach')){state=params[6];return {rows:[{id:'outreach'}],rowCount:1};}
    if(sql.startsWith('SELECT 1 FROM ops.organic_controls'))return {rows:[{}],rowCount:1};
    if(sql.includes("SET status='sent'"))state='sent';
    if(sql.includes("SET status='skipped'"))state='skipped';
    if(sql.includes('SET status=$3'))state=params[2];
    return {rows:[],rowCount:1};
  });
  return {query,connect:async()=>({query,release:vi.fn()}),trace,get status(){return state;}};
}
beforeEach(()=>{flags.FAREJADOR_ENV='prod';flags.BOT_AUDIO_ENABLED=true;});
it('envia uma única vez, registra antes do HTTP e usa preço consultado com a pergunta pedida',async()=>{
  const db=database();const graph:any={hasConversation:vi.fn(async()=>false),privateReply:vi.fn(async(_p,_a,_c,body)=>{
    expect(db.status).toBe('sending');expect(db.trace).toContain('COMMIT');
    expect(body.replace(/\u00a0/g,' ')).toContain('R$ 89,00');expect(body).not.toContain('900');
    expect(body).toMatch(/De onde você está falando, meu amigo\?$/);
    return {recipientId:'55',messageId:'mid.1'};
  })};
  expect(await sendOrganicPrivate(db as any,task,graph)).toBe(true);
  expect(await sendOrganicPrivate(db as any,task,graph)).toBe(true);
  expect(graph.privateReply).toHaveBeenCalledTimes(1);expect(db.status).toBe('sent');
});
it.each([true,false])('não repete entrega recusada ou incerta (incerta=%s)',async uncertain=>{
  const db=database(),graph:any={hasConversation:vi.fn(async()=>false),privateReply:vi.fn(async()=>{throw new MetaCommentError('meta_failure',uncertain);})};
  expect(await sendOrganicPrivate(db as any,task,graph)).toBe(false);
  expect(db.status).toBe(uncertain?'uncertain':'failed');
  expect(await sendOrganicPrivate(db as any,task,graph)).toBe(false);expect(graph.privateReply).toHaveBeenCalledTimes(1);
});
it('não aborda quando há atendimento ativo ou conversa anterior na plataforma',async()=>{
  const graph:any={hasConversation:vi.fn(async()=>true),privateReply:vi.fn()};
  const busy=database(true);expect(await sendOrganicPrivate(busy as any,task,graph)).toBe(false);
  expect(graph.hasConversation).not.toHaveBeenCalled();
  const old=database();expect(await sendOrganicPrivate(old as any,task,graph)).toBe(false);
  expect(old.status).toBe('skipped');expect(graph.privateReply).not.toHaveBeenCalled();
});
it('falha na consulta preserva a possibilidade de resposta pública, sem afirmar envio privado',async()=>{
  const db=database(),graph:any={hasConversation:vi.fn(async()=>{throw Error('connection');}),privateReply:vi.fn()};
  expect(await sendOrganicPrivate(db as any,task,graph)).toBe(false);expect(graph.privateReply).not.toHaveBeenCalled();
});
it('bloqueia ambiente de teste, áudio indisponível e Facebook ainda desligado',async()=>{
  const db=database(),graph:any={privateReply:vi.fn()};flags.FAREJADOR_ENV='test';
  expect(await sendOrganicPrivate(db as any,task,graph)).toBe(false);
  flags.FAREJADOR_ENV='prod';flags.BOT_AUDIO_ENABLED=false;
  expect(await sendOrganicPrivate(db as any,task,graph)).toBe(false);
  flags.BOT_AUDIO_ENABLED=true;expect(await sendOrganicPrivate(db as any,{...task,platform:'facebook'},graph)).toBe(false);
  expect(db.query).not.toHaveBeenCalled();expect(graph.privateReply).not.toHaveBeenCalled();
});
