import { describe, expect, it } from 'vitest';
import { estimateSolUsd,estimateSolCostParts,parseModelUsage,responseMetering } from '../../../src/atendente-v2/model-pricing.js';

const raw = { model:'gpt-5.6-sol',service_tier:'default',usage:{ input_tokens:10_000,output_tokens:1_000,
  input_tokens_details:{ cached_tokens:6_000,cache_write_tokens:2_000 },output_tokens_details:{ reasoning_tokens:800 } } };
describe('custo GPT-5.6 Sol', () => {
  it('inclui 6.1 com leitura de cache a 5%, sem alterar tarifas do 6 e 5.6',()=>{
    expect(estimateSolCostParts('gpt-6.1-sol','default',parseModelUsage(raw))).toEqual({
      inputUsd:.004,cacheReadUsd:.0006,cacheWriteUsd:.005,outputUsd:.01,totalUsd:.0196});
    expect(estimateSolUsd('gpt-6.1-sol-2026-10-21','default',parseModelUsage(raw))).toBe(.0196);
    expect(estimateSolUsd('gpt-6.1-sol','fast',parseModelUsage(raw))).toBeNull();
  });
  it('confere a estimativa de seis chamadas observadas, sem cobrar leitura como nova gravação',()=>{
    const usage={input:110324,cached:36624,cacheWrite:73682,output:499};
    expect(estimateSolCostParts('gpt-6.1-sol','default',usage)).toEqual({
      inputUsd:.000036,cacheReadUsd:.0036624,cacheWriteUsd:.184205,outputUsd:.00499,totalUsd:.1928934});
  });
  it('aplica a faixa longa por chamada também no 6.1',()=>{
    expect(estimateSolUsd('gpt-6.1-sol','default',{input:272000,cached:100000,cacheWrite:0,output:1000})).toBe(.364);
    expect(estimateSolUsd('gpt-6.1-sol','default',{input:300000,cached:100000,cacheWrite:0,output:1000})).toBe(.835);
  });
  it('separa escritas de 30 minutos e 12 horas quando o provedor informa as duas',()=>{
    const usage=parseModelUsage({usage:{input_tokens:12000,output_tokens:0,input_tokens_details:{cached_tokens:4000,
      cache_write_tokens:7000,cache_write_tokens_details:{ttl_30m_tokens:3000,ttl_12h_tokens:4000}}}});
    expect(usage).toMatchObject({input:12000,cacheWrite:7000,cacheWrite12h:4000});
    expect(estimateSolCostParts('gpt-6.1-sol','default',usage)).toEqual({
      inputUsd:.002,cacheReadUsd:.0004,cacheWriteUsd:.0275,outputUsd:0,totalUsd:.0299});
  });
  it('aplica preço GPT-6 Sol, inclusive cache e contexto longo, preservando 5.6', () => {
    expect(estimateSolUsd('gpt-6-sol','default',parseModelUsage(raw))).toBe(0.0202);
    expect(estimateSolUsd('gpt-6-sol-2026-09-15','default',parseModelUsage(raw))).toBe(0.0202);
    const usage={input:272_000,output:1_000,cached:0,cacheWrite:0};
    expect(estimateSolUsd('gpt-6-sol','default',usage)).toBe(0.554);
    expect(estimateSolUsd('gpt-6-sol','default',{...usage,input:300_000})).toBe(1.215);
    expect(estimateSolUsd('gpt-6-sol','priority',usage)).toBeNull();
    expect(estimateSolUsd('gpt-6-sol-pro','default',usage)).toBeNull();
  });
  it('separa entrada comum, cache lido/escrito e saída sem somar reasoning duas vezes', () => {
    expect(estimateSolUsd('gpt-5.6-sol','default',parseModelUsage(raw))).toBe(0.0404);
    expect(estimateSolUsd('gpt-5.6','default',parseModelUsage(raw))).toBe(0.0404);
  });
  it('aplica contexto longo por chamada, apenas acima de 272 mil tokens', () => {
    const usage={input:272_000,output:1_000,cached:0,cacheWrite:0};
    expect(estimateSolUsd('gpt-5.6-sol','default',usage)).toBe(1.108);
    expect(estimateSolUsd('gpt-5.6-sol','default',{...usage,input:300_000})).toBe(2.43);
  });
  it('não usa a tarifa Sol para outro modelo ou nível de serviço', () => {
    for(const model of ['gpt-4o-mini','gpt-5.6-terra','gpt-5.6-sol-pro'])
      expect(estimateSolUsd(model,'default',parseModelUsage(raw))).toBeNull();
    expect(estimateSolUsd('gpt-5.6-sol','priority',parseModelUsage(raw))).toBeNull();
    expect(responseMetering({...raw,model:'gpt-5.6-terra'},'gpt-5.6-sol').model).toBe('gpt-5.6-terra');
    expect(responseMetering({...raw,service_tier:undefined},'gpt-5.6-sol').tier).toBe('unknown');
  });
  it.each([undefined,{}, {usage:{}},{usage:{...raw.usage,input_tokens:-1}},
    {usage:{...raw.usage,output_tokens:0.5}},
    {usage:{...raw.usage,input_tokens_details:{cached_tokens:6_000}}},
    {usage:{...raw.usage,input_tokens_details:{cached_tokens:9_000,cache_write_tokens:2_000}}},
  ])('uso ausente/inválido não vira custo zero', value => {
    expect(parseModelUsage(value)).toBeNull();
    expect(estimateSolUsd('gpt-5.6-sol','default',parseModelUsage(value))).toBeNull();
  });
  it('aceita consumo realmente zero informado pelo provedor', () => {
    const zero=parseModelUsage({usage:{input_tokens:0,output_tokens:0,input_tokens_details:{cached_tokens:0,cache_write_tokens:0}}});
    expect(estimateSolUsd('gpt-5.6-sol','default',zero)).toBe(0);
  });
});
