import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {ChatMessage,ToolDefinition} from '../../../src/atendente-v2/types.js';
import {buildAgentMessages,staticPromptCache} from '../../../src/atendente-v2/prompt-cache.js';
import {functionItem,jsonResponse,reasoningItem,responseBody} from './responses-fixtures.js';
const config=vi.hoisted(()=>({OPENAI_MODEL:'gpt-6.1-sol',OPENAI_API_KEY:'fixture-only',OPENAI_TIMEOUT_MS:1000,AGENT_V2_MAX_OUTPUT_TOKENS:8192}));
vi.mock('../../../src/shared/config/env.js',()=>({env:config}));
vi.mock('../../../src/shared/logger.js',()=>({logger:{warn:vi.fn()}}));
import {createOpenAIResponsesTurn} from '../../../src/atendente-v2/openai-responses.js';
const rules='Regras fixas: pagamentos, ferramentas e atendimento 24h.';
const definition:ToolDefinition={type:'function',function:{name:'buscar_produto',description:'Consulta atual de estoque',parameters:{type:'object',properties:{}}}};
const history:ChatMessage[]=[{role:'user',content:'Quero dois 100/80-14 para retirar. Endereço: Rua Teste A, 10, Centro.'},
 {role:'assistant',content:null,tool_calls:[{id:'past_call',type:'function',function:{name:'buscar_produto',arguments:'{"medida":"100/80-14"}'}}]},
 {role:'tool',tool_call_id:'past_call',content:'{"product_id":"pneu-escolhido","price":89,"available":2}'},
 {role:'assistant',content:'Esse fica R$ 89,00 cada.'},
 {role:'user',content:'Corrigindo: quero só um, por entrega na Rua Teste B, 25, bairro Novo. Vou pagar no cartão.'}];
const fetcher=vi.fn<typeof fetch>();
beforeEach(()=>{fetcher.mockReset();vi.stubGlobal('fetch',fetcher);config.OPENAI_MODEL='gpt-6.1-sol';});
afterEach(()=>vi.unstubAllGlobals());
const request=(n=0)=>JSON.parse(String(fetcher.mock.calls[n]?.[1]?.body));
describe('cache das regras sem perder contexto',()=>{
 it('mantém todo o histórico, preços consultados, alterações de pedido e endereço na mesma ordem',()=>{
  const original=structuredClone(history),context='Cliente atual, endereço confirmado e localização recebida.';
  const messages=buildAgentMessages(config.OPENAI_MODEL,rules,context,history);
  expect(messages.slice(2)).toEqual(original);expect(history).toEqual(original);
  expect(messages[0]).toEqual({role:'developer',content:rules});expect(messages[1]).toEqual({role:'developer',content:context});
  expect(messages.slice(0,2).map(message=>message.content).join('')).toBe(rules+context);
 });
 it('mantém o prefixo idêntico ao trocar cliente/endereço, sem carregar dados de outra conversa',()=>{
  const a=buildAgentMessages(config.OPENAI_MODEL,rules,'Endereço A',[{role:'user',content:'Cliente A'}]);
  const b=buildAgentMessages(config.OPENAI_MODEL,rules,'Endereço B',[{role:'user',content:'Cliente B'}]);
  expect(a[0]).toEqual(b[0]);expect(JSON.stringify(b)).not.toContain('Endereço A');expect(JSON.stringify(b)).not.toContain('Cliente A');
 });
 it.each(['gpt-6-sol','gpt-5.6-sol','gpt-4o-mini'])('preserva o envio anterior para %s',model=>{
  const messages=buildAgentMessages(model,rules,'contexto',history);
  expect(messages).toEqual([{role:'system',content:rules+'contexto'},...history]);
  expect(staticPromptCache(messages as unknown as Record<string,unknown>[],model,true)).not.toHaveProperty('prompt_cache_options');
 });
 it('marca somente regras estáveis e envia endereço e histórico atualizados fora do cache explícito',async()=>{
  const messages=buildAgentMessages(config.OPENAI_MODEL,rules,'Endereço atual: Rua Teste B, 25.',history);
  fetcher.mockResolvedValue(jsonResponse(responseBody()));
  await createOpenAIResponsesTurn(messages,[definition],undefined,{cacheStaticPrefix:true}).next();
  const sent=request();
  expect(sent.model).toBe('gpt-6.1-sol');expect(sent.store).toBe(false);expect(sent.reasoning).toEqual({effort:'medium'});
  expect(sent.prompt_cache_options).toEqual({mode:'explicit',ttl:'30m'});
  expect(sent.input[0]).toEqual({role:'developer',content:[{type:'input_text',text:rules,prompt_cache_breakpoint:{mode:'explicit'}}]});
  expect(JSON.stringify(sent.input.slice(1))).not.toContain('prompt_cache_breakpoint');
  expect(sent.input[1]).toEqual({role:'developer',content:'Endereço atual: Rua Teste B, 25.'});
  expect(sent.input).toContainEqual({role:'user',content:history.at(-1)!.content});
  expect(sent.input).toContainEqual({type:'function_call_output',call_id:'past_call',output:history[2]!.content});
  expect(sent.tools).toEqual([{type:'function',...definition.function,strict:false}]);
  expect(sent).not.toHaveProperty('prompt_cache_retention');expect(sent.prompt_cache_options).not.toHaveProperty('prewarm');
  expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('conserva ferramenta, call_id e reasoning entre rodadas sem mudar o prefixo',async()=>{
  const messages=buildAgentMessages(config.OPENAI_MODEL,rules,'Localização e pedido atuais',history);
  const output=[reasoningItem,functionItem('new_call')];
  fetcher.mockResolvedValueOnce(jsonResponse(responseBody(output))).mockResolvedValueOnce(jsonResponse(responseBody()));
  const session=createOpenAIResponsesTurn(messages,[definition],undefined,{cacheStaticPrefix:true});
  await session.next();session.appendToolResult('new_call','{"available":1}');await session.next();
  expect(request(1).input[0]).toEqual(request(0).input[0]);
  expect(request(1).input).toEqual([...request(0).input,...output,{type:'function_call_output',call_id:'new_call',output:'{"available":1}'}]);
  expect(request(1).prompt_cache_options).toEqual(request(0).prompt_cache_options);
 });
 it.each([[{role:'user',content:'Endereço do cliente'}],[{role:'developer',content:''}]])('não desliga o cache implícito sem um prefixo fixo válido (%j)',input=>{
  expect(staticPromptCache(input,'gpt-6.1-sol',true)).toEqual({input});
 });
});
