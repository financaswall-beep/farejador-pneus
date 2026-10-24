import { readPage, rejectFilters, type DotReadContext } from './read-model.js';
import { dotChatwootAccount } from './chat-scope.js';
import { measurePattern } from './safe-values.js';

export async function readDotBot(ctx:DotReadContext,view:'conversao'|'demanda'|'faltas'|'espera') {
  if(view==='conversao')rejectFilters(ctx,'medida');
  const account=await dotChatwootAccount(ctx.db);
  if(!account)return {available:false,reason:'chatwoot_account_not_configured_or_ambiguous'};
  if(view==='conversao')return readPage(ctx,`SELECT (c.started_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS id,
    count(*)::int conversations,count(*) FILTER(WHERE cc.value='fechou')::int with_valid_order,
    count(*) FILTER(WHERE cc.value='escalou')::int handoffs,
    count(*) FILTER(WHERE cc.value IN ('abandonou','desistiu_cedo'))::int abandoned,
    count(*) FILTER(WHERE cc.value='cancelado')::int cancelled,
    count(*) FILTER(WHERE cc.value IS NULL)::int unclassified
    FROM core.conversations c LEFT JOIN analytics.current_classifications cc ON cc.environment=c.environment
      AND cc.conversation_id=c.id AND cc.dimension='final_outcome'
    WHERE c.environment=$1 AND c.chatwoot_account_id=${account} AND c.deleted_at IS NULL
      AND (c.started_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2::date AND $3::date
      AND ($4::uuid IS NULL OR c.id=$4) AND $5='' GROUP BY 1`,'id DESC',
  'Coorte por início da conversa na conta conectada. Pedido válido no atendimento não comprova realização ou recebimento.');
  if(view==='espera')return readPage(ctx,`SELECT tire_size AS id,tire_size,tire_condition,status,count(*)::int interests,
    min(consent_at) oldest_consent_at,max(consent_at) latest_consent_at FROM ops.stock_interests
    WHERE environment=$1 AND (consent_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2::date AND $3::date
      AND ($4::uuid IS NULL OR id=$4) AND ($5='' OR tire_size ILIKE '%'||$5||'%')
      AND EXISTS(SELECT 1 FROM core.conversations c WHERE c.environment=ops.stock_interests.environment
        AND c.id=ops.stock_interests.conversation_id AND c.chatwoot_account_id=${account} AND c.deleted_at IS NULL)
      AND tire_size ~ '${measurePattern}'
    GROUP BY tire_size,tire_condition,status`,'interests DESC,id,tire_condition,status',
  'Fila de espera agregada por medida/condição/status, sem contatos, consentimentos em texto ou mensagens.');
  const measure=view==='faltas'?`f.fact_value->>'medida'`:`f.fact_value #>> '{}'`;
  return readPage(ctx,`SELECT ${measure} AS id,${measure} measure,
    count(DISTINCT f.conversation_id)::int conversations,max(COALESCE(f.observed_at,f.created_at)) last_observed_at
    FROM analytics.conversation_facts f JOIN core.conversations c ON c.environment=f.environment AND c.id=f.conversation_id
    WHERE f.environment=$1 AND f.superseded_by IS NULL AND c.chatwoot_account_id=${account} AND c.deleted_at IS NULL
      AND f.fact_key='${view==='faltas'?'faltou_estoque':'medida_consultada'}'
      AND (COALESCE(f.observed_at,f.created_at) AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2::date AND $3::date
      AND ($4::uuid IS NULL OR f.conversation_id=$4) AND ($5='' OR ${measure} ILIKE '%'||$5||'%')
      AND ${measure} ~ '${measurePattern}' GROUP BY ${measure}`,'conversations DESC,id',
  'Demanda por conversas distintas; mede interesse, sem criar reserva ou prometer disponibilidade.');
}
