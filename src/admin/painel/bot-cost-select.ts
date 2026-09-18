/** Aggregate the same metering columns for Bot and Rede. Unknown cost is not zero. */
export const BOT_COST_TOTALS_SQL = `
  CASE WHEN COALESCE(sum(custo_bot_pendente),0)>0 THEN NULL
    ELSE COALESCE(sum(custo_bot_brl),0) END::numeric AS custo_bot,
  COALESCE(sum(custo_bot_pendente),0)::int AS custo_bot_pendente,
  COALESCE(sum(custo_bot_parcial_brl),0)::numeric AS custo_bot_parcial,
  CASE WHEN COALESCE(sum(custo_bot_pendente),0)>0 THEN NULL
    ELSE COALESCE(sum(custo_bot_usd),0) END::numeric AS custo_bot_usd,
  min(cambio_min)::numeric AS cambio_min,max(cambio_max)::numeric AS cambio_max`;
