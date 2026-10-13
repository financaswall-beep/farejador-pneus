import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {functionItem,jsonResponse,responseBody,textItem} from './responses-fixtures.js';
const mock=vi.hoisted(()=>({history:vi.fn(),send:vi.fn(),query:vi.fn(),release:vi.fn(),may:vi.fn(),tool:vi.fn()}));
vi.mock('../../../src/persistence/db.js',()=>({pool:{connect:async()=>({query:mock.query,release:mock.release})}}));
vi.mock('../../../src/atendente-v2/history.js',()=>({loadHistory:mock.history,lookupChatwootConversationId:async()=>42}));
vi.mock('../../../src/atendente-v2/final-send.js',()=>({sendFinalAgentText:mock.send}));
vi.mock('../../../src/atendente-v2/conversation-control.js',()=>({botMayProcessTrigger:mock.may}));
vi.mock('../../../src/atendente-v2/tools.js',()=>({activeToolDefinitions:()=>[{type:'function',function:{name:'escalar_humano',
  description:'Encaminhar para atendimento humano',parameters:{type:'object',properties:{motivo:{type:'string'},resumo:{type:'string'}}}}}],executeTool:mock.tool}));
vi.mock('../../../src/shared/logger.js',()=>({logger:{warn:vi.fn(),error:vi.fn(),info:vi.fn()}}));
const job={environment:'test',conversationId:'conv',jobId:'job',triggerMessageId:'trigger'};
beforeEach(()=>{
  Object.assign(process.env,{NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:'postgres://unused',CHATWOOT_HMAC_SECRET:'fixture',
    ADMIN_AUTH_TOKEN:'fixture',OPENAI_API_KEY:'fixture',OPENAI_MODEL:'gpt-5.6-sol',PARTNER_STOCK_CONFIRMATION:'true',
    ROUTING_GEO:'false',PHOTO_REQUESTS:'false',ORGANIC_ATTRIBUTION_ENABLED:'false',SATISFACTION_SURVEY:'false'});
  vi.resetAllMocks();mock.may.mockResolvedValue(true);mock.query.mockResolvedValue({rows:[]});mock.send.mockResolvedValue('sent');
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(jsonResponse(responseBody([textItem('Como posso ajudar?')]))));
});
afterEach(()=>vi.unstubAllGlobals());
describe('integração do agente com estado operacional',()=>{
  it('terceiro cumprimento gera encaminhamento real sem chamada OpenAI nem ferramenta comercial',async()=>{
    mock.history.mockResolvedValue([{role:'user',content:'Oi!'},{role:'assistant',content:'Como posso ajudar?'},
      {role:'user',content:'Bom dia!'},{role:'assistant',content:'Me conta o que precisa.'},{role:'user',content:'Boa noite!'}]);
    const {runAgentV2}=await import('../../../src/atendente-v2/agent.js');await runAgentV2(job);
    expect(fetch).not.toHaveBeenCalled();expect(mock.tool).not.toHaveBeenCalled();expect(mock.send).toHaveBeenCalledTimes(1);
    expect(mock.send.mock.calls[0][1]).toMatchObject({humanHandoff:true,inputTokens:0,outputTokens:0,triggerMessageId:'trigger'});
    expect(mock.send.mock.calls[0][1].actions[0].tool_calls[0].function.name).toBe('escalar_humano');
  });
  it('cumprimento com pedido segue para o modelo e não encaminha como repetição vazia',async()=>{
    mock.history.mockResolvedValue([{role:'user',content:'Oi!'},{role:'user',content:'Bom dia!'},{role:'user',content:'Boa noite, quero 90/90-18'}]);
    const {runAgentV2}=await import('../../../src/atendente-v2/agent.js');await runAgentV2(job);
    expect(fetch).toHaveBeenCalledTimes(1);expect(mock.send.mock.calls[0][1].humanHandoff).toBeUndefined();
  });
  it('estado atual do TENHO prevalece sobre busca pendente antiga e corrige negação do conjunto',async()=>{
    const request={id:'r',unit_id:'unit',environment:'test',status:'confirmed',valid_until:new Date(Date.now()+60000),
      routing:{location:{municipio:'Rio de Janeiro'},items:[{product_id:'p1',quantity:1},{product_id:'p2',quantity:1}]},
      items:[{tire_size:'90/90-18',price:55},{tire_size:'140/70-17',price:89.9}]};
    mock.history.mockResolvedValue([{role:'user',content:'Quero os dois pneus, no Méier.'},
      {role:'assistant',content:'A loja confirmou os dois.'},{role:'user',content:'Não entendi, explica mais fácil.'}]);
    mock.query.mockImplementation(async(sql:string,values:unknown[])=>({rows:
      sql.includes('FROM commerce.partner_stock_requests')?[request]
      :sql.includes('FROM network.partner_units pu')?[{name:'Borracharia Teste',hours:[0,1,2,3,4,5,6].map(day=>({day,opens_at:'00:00',closes_at:'23:59'}))}]
      :sql.includes('FROM commerce.partner_stock_levels')?[{id:values[2],item_name:'Pneu',sale_price:values[2]==='p1'?'55':'89.9'}]:[]}));
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(jsonResponse(responseBody([textItem('Não consigo confirmar os dois na mesma loja.')]))));
    const {runAgentV2}=await import('../../../src/atendente-v2/agent.js');await runAgentV2(job);
    const sent=mock.send.mock.calls[0][1].body;expect(sent).toContain('A loja confirmou');expect(sent).toContain('mesma loja');
    const payload=JSON.parse(String((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body));
    expect(payload.input[0].content).toContain('[CONFIRMAÇÃO ATUAL DO PARCEIRO]');
    expect(payload.input[0].content).toContain('"productId":"p1"');expect(payload.input[0].content).toContain('"productId":"p2"');
  });
  it('não pausa a conversa por falsa impossibilidade de consultar a mesma loja',async()=>{
    const request={id:'r',unit_id:'unit',environment:'test',status:'confirmed',valid_until:new Date(Date.now()+60000),
      routing:{location:{municipio:'Rio de Janeiro'},items:[{product_id:'p1',quantity:1},{product_id:'p2',quantity:1}]},
      items:[{tire_size:'90/90-18',price:55},{tire_size:'140/70-17',price:89.9}]};
    mock.history.mockResolvedValue([{role:'user',content:'Pode verificar e fechar somente se os dois forem da mesma loja.'}]);
    mock.query.mockImplementation(async(sql:string,values:unknown[])=>({rows:
      sql.includes('FROM commerce.partner_stock_requests')?[request]
      :sql.includes('FROM network.partner_units pu')?[{name:'Borracharia Teste',hours:[0,1,2,3,4,5,6].map(day=>({day,opens_at:'00:00',closes_at:'23:59'}))}]
      :sql.includes('FROM commerce.partner_stock_levels')?[{id:values[2],item_name:'Pneu',sale_price:values[2]==='p1'?'55':'89.9'}]:[]}));
    const args={motivo:'duvida_complexa',resumo:'As ferramentas não confirmam que os dois pneus saem da mesma loja.'};
    vi.stubGlobal('fetch',vi.fn()
      .mockResolvedValueOnce(jsonResponse(responseBody([functionItem('handoff','escalar_humano',JSON.stringify(args))])))
      .mockResolvedValueOnce(jsonResponse(responseBody([textItem('Os dois foram confirmados na Borracharia Teste. Vou verificar os dados para fechar.')]))) );
    const {runAgentV2}=await import('../../../src/atendente-v2/agent.js');await runAgentV2(job);
    expect(mock.tool).not.toHaveBeenCalled();expect(fetch).toHaveBeenCalledTimes(2);
    expect(mock.send).toHaveBeenCalledTimes(1);expect(mock.send.mock.calls[0][1].humanHandoff).toBeUndefined();
    expect(mock.send.mock.calls[0][1].actions[1]).toMatchObject({role:'tool',tool_call_id:'handoff'});
    expect(JSON.parse(mock.send.mock.calls[0][1].actions[1].content)).toMatchObject({erro:'conjunto_ja_confirmado'});
  });
});
