import { describe, expect, it } from 'vitest';
import { estimateSolUsd, parseModelUsage, responseMetering } from '../../../src/atendente-v2/model-pricing.js';

const raw = { model:'gpt-5.6-sol',service_tier:'default',usage:{ input_tokens:10_000,output_tokens:1_000,
  input_tokens_details:{ cached_tokens:6_000,cache_write_tokens:2_000 },output_tokens_details:{ reasoning_tokens:800 } } };
describe('custo GPT-5.6 Sol', () => {
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
