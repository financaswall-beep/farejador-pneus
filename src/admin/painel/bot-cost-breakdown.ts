import type {Pool} from 'pg';
import {BOT_PRICING_VERSION,estimateSolCostParts,type ModelCostParts} from '../../atendente-v2/model-pricing.js';

export interface BotCostBreakdown extends ModelCostParts {calls:number;unavailableCalls:number}

/** Apenas metadados. Não lê conversas, não reprecifica o histórico nem altera custos gravados. */
export async function readBotCostBreakdown(db:Pool,environment:string,from:string,to:string):Promise<BotCostBreakdown> {
  const result=await db.query(`SELECT model,service_tier,pricing_version,
      count(*)::int calls,count(*) FILTER(WHERE estimated_usd IS NULL)::int missing,
      avg(input_tokens)::float8 input,avg(output_tokens)::float8 output,
      avg(cached_tokens)::float8 cached,avg(cache_write_tokens)::float8 writes,
      sum(estimated_usd)::float8 usd
    FROM ops.bot_model_usage WHERE environment=$1
      AND created_at>=($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
      AND created_at<(($3::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
    GROUP BY model,service_tier,pricing_version,(input_tokens>272000)`,[environment,from,to]);
  const out:BotCostBreakdown={inputUsd:0,cacheReadUsd:0,cacheWriteUsd:0,outputUsd:0,totalUsd:0,calls:0,unavailableCalls:0};
  for(const row of result.rows){
    // As tarifas são lineares dentro da faixa de contexto de CADA chamada.
    // A média evita transferir milhares de registros e mantém a faixa original.
    const valid=[row.input,row.output,row.cached,row.writes,row.usd].every(value=>Number.isFinite(value)&&value>=0)
      && row.cached+row.writes<=row.input;
    const parts=valid && row.pricing_version===BOT_PRICING_VERSION && !row.missing
      ? estimateSolCostParts(row.model,row.service_tier,{input:row.input,output:row.output,cached:row.cached,cacheWrite:row.writes}) : null;
    // TTL antigo/desconhecido ou outra versão: só detalhar se o total conferir
    // com o snapshot gravado. Nunca apresentar uma estimativa nova como histórica.
    if(!parts || Math.abs(parts.totalUsd*row.calls-Number(row.usd))>Math.max(1e-8,row.calls*1e-9)){
      out.unavailableCalls+=row.calls;continue;
    }
    out.calls+=row.calls;
    for(const key of ['inputUsd','cacheReadUsd','cacheWriteUsd','outputUsd','totalUsd'] as const)
      out[key]+=parts[key]*row.calls;
  }
  for(const key of ['inputUsd','cacheReadUsd','cacheWriteUsd','outputUsd','totalUsd'] as const)
    out[key]=Number(out[key].toFixed(8));
  return out;
}
