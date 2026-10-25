/** Standard text pricing checked 2026-10-25:
 * https://developers.openai.com/api/docs/pricing
 * https://developers.openai.com/api/docs/guides/prompt-caching
 * USD estimates exclude taxes, currency spread and other services. */
export const BOT_PRICING_VERSION = 'sol:standard:2026-10-25';
export interface ModelUsage {
  input: number; output: number; cached: number; cacheWrite: number;
  cacheWrite12h?:number;
}
export interface ModelCostParts {inputUsd:number;cacheReadUsd:number;cacheWriteUsd:number;outputUsd:number;totalUsd:number}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
const tokens = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

export function parseModelUsage(raw: unknown): ModelUsage | null {
  const usage = object(object(raw).usage), details = object(usage.input_tokens_details);
  const { input_tokens: input, output_tokens: output } = usage;
  const cached = details.cached_tokens, cacheWrite = details.cache_write_tokens;
  // Missing metering is not zero usage. In particular, Sol charges cache writes.
  if (!tokens(input) || !tokens(output) || !tokens(cached) || !tokens(cacheWrite)
    || cached + cacheWrite > input) return null;
  const writes=details.cache_write_tokens_details;
  if(writes!==undefined&&writes!==null){
    const {ttl_30m_tokens:short,ttl_12h_tokens:long}=object(writes);
    if(!tokens(short)||!tokens(long)||short+long!==cacheWrite)return null;
    return {input,output,cached,cacheWrite,cacheWrite12h:long};
  }
  return { input, output, cached, cacheWrite };
}

export function estimateSolCostParts(model:string,tier:string,usage:ModelUsage|null):ModelCostParts|null {
  const sol61=/^gpt-6\.1-sol(?:-\d{4}-\d{2}-\d{2})?$/.test(model);
  const sol6 = /^gpt-6-sol(?:-\d{4}-\d{2}-\d{2})?$/.test(model);
  const sol56 = /^gpt-5\.6(?:-sol)?(?:-\d{4}-\d{2}-\d{2})?$/.test(model);
  if (!usage || (!sol61 && !sol6 && !sol56) || tier !== 'default') return null;
  const long = usage.input > 272_000;
  const inputRate = (long ? 8 : 4) / (sol6||sol61 ? 2 : 1), outputRate = (long ? 30 : 20) / (sol6||sol61 ? 2 : 1);
  const ordinary = usage.input - usage.cached - usage.cacheWrite;
  const writes12h=usage.cacheWrite12h??0,round=(value:number)=>Number(value.toFixed(10));
  const inputUsd=round(ordinary*inputRate/1e6),cacheReadUsd=round(usage.cached*inputRate*(sol61 ? 0.05 : 0.1)/1e6);
  const cacheWriteUsd=round(((usage.cacheWrite-writes12h)*1.25+writes12h*2.5)*inputRate/1e6);
  const outputUsd=round(usage.output*outputRate/1e6);
  return {inputUsd,cacheReadUsd,cacheWriteUsd,outputUsd,totalUsd:round(inputUsd+cacheReadUsd+cacheWriteUsd+outputUsd)};
}
export function estimateSolUsd(model:string,tier:string,usage:ModelUsage|null):number|null {
  return estimateSolCostParts(model,tier,usage)?.totalUsd??null;
}

export function responseMetering(raw: unknown, requestedModel: string) {
  const response = object(raw);
  return {
    responseId: typeof response.id === 'string' ? response.id : null,
    model: typeof response.model === 'string' ? response.model : requestedModel,
    tier: typeof response.service_tier === 'string' ? response.service_tier : 'unknown',
    status: typeof response.status === 'string' ? response.status : 'unknown',
    usage: parseModelUsage(raw),
  };
}
