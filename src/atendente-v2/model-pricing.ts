/** Standard text pricing checked 2026-09-17:
 * https://developers.openai.com/api/docs/models/gpt-5.6-sol
 * https://developers.openai.com/api/docs/guides/prompt-caching
 * USD estimates exclude taxes, currency spread and other services. */
export const BOT_PRICING_VERSION = 'gpt-5.6-sol:standard:2026-09-17';
export interface ModelUsage {
  input: number; output: number; cached: number; cacheWrite: number;
}
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
  return { input, output, cached, cacheWrite };
}

export function estimateSolUsd(model: string, tier: string, usage: ModelUsage | null): number | null {
  if (!usage || !/^gpt-5\.6(?:-sol)?(?:-\d{4}-\d{2}-\d{2})?$/.test(model)
    || tier !== 'default') return null;
  const long = usage.input > 272_000;
  const inputRate = long ? 8 : 4, outputRate = long ? 30 : 20;
  const ordinary = usage.input - usage.cached - usage.cacheWrite;
  return Number(((ordinary * inputRate + usage.cached * inputRate * 0.1
    + usage.cacheWrite * inputRate * 1.25 + usage.output * outputRate) / 1_000_000).toFixed(10));
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
