import type {Pool} from 'pg';

/** Aggregate the same metering columns for Bot and Rede. Unknown cost is not zero. */
export const BOT_COST_TOTALS_SQL = `
  CASE WHEN COALESCE(sum(custo_bot_pendente),0)>0 THEN NULL
    ELSE COALESCE(sum(custo_bot_brl),0) END::numeric AS custo_bot,
  COALESCE(sum(custo_bot_pendente),0)::int AS custo_bot_pendente,
  COALESCE(sum(custo_bot_parcial_brl),0)::numeric AS custo_bot_parcial,
  CASE WHEN COALESCE(sum(custo_bot_pendente),0)>0 THEN NULL
    ELSE COALESCE(sum(custo_bot_usd),0) END::numeric AS custo_bot_usd,
  min(cambio_min)::numeric AS cambio_min,max(cambio_max)::numeric AS cambio_max`;

/** sinceSql é um fragmento constante escolhido pelo painel, nunca entrada HTTP. */
export async function readBotVisaoCards(db:Pool,environment:string,sinceSql:string):Promise<Record<string,unknown>|null> {
  const r=await db.query(`SELECT
    COALESCE(sum(conversas_total),0)::int AS conversas,
    COALESCE(sum(fecharam),0)::int AS fecharam,
    COALESCE(sum(escalaram),0)::int AS escalaram,
    COALESCE(sum(abandonaram),0)::int AS abandonaram,
    ${BOT_COST_TOTALS_SQL},
    CASE WHEN sum(conversas_total)>0 THEN round(100.0*sum(fecharam)/sum(conversas_total),1) ELSE 0 END AS taxa_conversao,
    COALESCE(sum(faturamento),0)::numeric AS faturamento,
    CASE WHEN sum(fecharam)>0 THEN round(sum(faturamento)/sum(fecharam),2) ELSE NULL END AS ticket_medio,
    round(avg(resposta_media_seg) FILTER(WHERE resposta_media_seg IS NOT NULL))::int AS resposta_seg,
    COALESCE(sum(conv_madrugada),0)::int AS conv_madrugada,
    COALESCE(sum(conv_manha),0)::int AS conv_manha,
    COALESCE(sum(conv_tarde),0)::int AS conv_tarde,
    COALESCE(sum(conv_noite),0)::int AS conv_noite
    FROM analytics.v_daily_metrics WHERE environment=$1 AND dia>=${sinceSql}`,[environment]);
  const cards=r.rows[0]??null;
  if(cards){
    // Régua fixa de 48h: conversas distintas com resposta enviada, como na campainha.
    const r48=await db.query(`SELECT count(DISTINCT t.conversation_id)::int AS respondidas_bot_48h
      FROM agent.turns t WHERE t.environment=$1 AND t.agent_version='v2' AND t.status IN ('delivered','sent_api_ack')
      AND t.created_at>now()-interval '48 hours'`,[environment]);
    cards.respondidas_bot_48h=r48.rows[0]?.respondidas_bot_48h??0;
  }
  return cards;
}
