import type { PoolClient } from 'pg';
import { env } from '../shared/config/env.js';
import type { AgentV2JobInput } from './types.js';
import type { OpenAIRequestObservation } from './openai-responses-http.js';
import { BOT_PRICING_VERSION, estimateSolUsd, responseMetering } from './model-pricing.js';

/** Only metering metadata; never prompt, response text, tool arguments or reasoning. */
export async function recordBotModelUsage(client: PoolClient, job: AgentV2JobInput,
  event: OpenAIRequestObservation): Promise<void> {
  const metering = responseMetering(event.response, env.OPENAI_MODEL);
  const usd = estimateSolUsd(metering.model, metering.tier, metering.usage);
  await client.query(`INSERT INTO ops.bot_model_usage (
      id,environment,job_id,conversation_id,trigger_message_id,response_id,model,service_tier,
      provider_status,input_tokens,output_tokens,cached_tokens,cache_write_tokens,
      estimated_usd,usd_brl,pricing_version
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    ON CONFLICT DO NOTHING`,
  [event.id,job.environment,job.jobId,job.conversationId,job.triggerMessageId,metering.responseId,
    metering.model,metering.tier,event.failure ?? metering.status,
    metering.usage?.input ?? null,metering.usage?.output ?? null,
    metering.usage?.cached ?? null,metering.usage?.cacheWrite ?? null,
    usd,env.OPENAI_USD_BRL,usd === null ? null : BOT_PRICING_VERSION]);
}
