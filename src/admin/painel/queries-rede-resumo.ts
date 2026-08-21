// Obra 300 (2026-07-05): fatia do banco da MATRIZ — funil da Rede + resumo da matriz (getMatrizResumo).
// VERBATIM das linhas 390-513 do queries.ts pré-obra (commit 2628748).
// Porta de entrada continua sendo ./queries.js (barrel) — importadores não mudam.
import type { Pool, PoolClient } from 'pg';
import { randomBytes } from 'node:crypto';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { normalizeBrazilianPhone } from '../../shared/phone.js';
import { applyWholesaleStockDecrement, applyWholesaleStockReturn } from './wholesale-stock.js';
import { resolveMeasureInCatalog } from './wholesale-catalog.js';
import { applyMatrizGalpaoDecrement, applyMatrizGalpaoReturn, applyMatrizRetailCostSnapshot } from '../../atendente-v2/wholesale-stock-read.js';
import { hashPassword } from '../../parceiro/password.js';
import { resolveRedePeriodStartSql, type PainelRedePeriod } from './queries-pedidos.js';

export interface RedeFunnelRow {
  municipio: string;
  unit_id: string | null;
  tentou: number;
  pediu: number;
  efetivou: number;
}

/**
 * Funil de conversão da REDE por município (Analytics da Rede v1) — desempenho do BOT
 * na área de cada parceiro:
 *   - tentou:   conversas em que o bot OFERTOU entrega na região (fact `municipio_entrega`);
 *   - pediu:    dessas, quantas viraram pedido DO PARCEIRO (espelho com `partner_order_id`);
 *   - efetivou: desses, quantos foram ENTREGUES (`delivery_status='delivered'`).
 * `unit_id` = unidade parceira que atende o município (v1: 1 parceiro/município, derivado
 * dos pedidos existentes; vira `network.unit_coverage` quando houver vários). Só leitura.
 */
export interface RedeFunnelResult {
  rows: RedeFunnelRow[];
  unassigned: number;
}

export async function getRedeFunnel(
  period: PainelRedePeriod = 'month',
  dbPool: Pool = defaultPool,
): Promise<RedeFunnelResult> {
  const periodStartSql = resolveRedePeriodStartSql(period);
  const result = await dbPool.query(
    `WITH decisions AS (
       SELECT d.conversation_id,d.unit_id,d.municipio
         FROM ops.partner_routing_decisions d
        WHERE d.environment=$1 AND d.decided_at>=${periodStartSql}::timestamptz
     ), attempts AS (
       SELECT d.unit_id,max(d.municipio) AS municipio,
              count(DISTINCT d.conversation_id)::int AS tentou
         FROM decisions d WHERE d.unit_id IS NOT NULL GROUP BY d.unit_id
     ), orders AS (
       SELECT po.unit_id,max(d.municipio) AS municipio,
              count(DISTINCT o.source_conversation_id)::int AS pediu,
              count(DISTINCT o.source_conversation_id)
                FILTER (WHERE po.delivery_status='delivered')::int AS efetivou
         FROM commerce.orders o
         JOIN commerce.partner_orders po
           ON po.id=o.partner_order_id AND po.environment=o.environment
         LEFT JOIN decisions d ON d.conversation_id=o.source_conversation_id
        WHERE o.environment=$1 AND o.source_conversation_id IS NOT NULL
          AND po.created_at>=${periodStartSql}::timestamptz
          AND po.deleted_at IS NULL AND po.status<>'cancelled'
        GROUP BY po.unit_id
     )
     SELECT COALESCE(a.municipio,o.municipio,'Sem municipio') AS municipio,
            COALESCE(a.unit_id,o.unit_id)::text AS unit_id,
            GREATEST(COALESCE(a.tentou,0),COALESCE(o.pediu,0))::int AS tentou,
            COALESCE(o.pediu,0)::int AS pediu,
            COALESCE(o.efetivou,0)::int AS efetivou
       FROM attempts a FULL JOIN orders o ON o.unit_id=a.unit_id
      ORDER BY tentou DESC`,
    [env.FAREJADOR_ENV],
  );
  const unassigned = await dbPool.query<{ total: number }>(
    `SELECT count(DISTINCT conversation_id)::int AS total
       FROM ops.partner_routing_decisions
      WHERE environment=$1 AND decision_kind='unresolved'
        AND decided_at>=${periodStartSql}::timestamptz`,
    [env.FAREJADOR_ENV],
  );
  return {
    rows: result.rows as RedeFunnelRow[],
    unassigned: Number(unassigned.rows[0]?.total ?? 0),
  };
}

export interface MatrizResumo {
  metrics: Record<string, unknown> | null;
  series: unknown[];
  leads: unknown[];
}

/**
 * Resumo do dono (cockpit da matriz): performance do BOT/tráfego + leads a recuperar.
 * LÊ (read-only) das views derivadas do V2 — nunca escreve em analytics/agent/core.
 * Distinto da aba Rede (que é operação dos parceiros). Janela: today/7d/30d/month.
 *
 * Defensivo por bloco: se uma view faltar/quebrar, devolve o bloco vazio em vez
 * de derrubar o endpoint inteiro.
 */
export async function getMatrizResumo(
  period: PainelRedePeriod = '7d',
  dbPool: Pool = defaultPool,
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
): Promise<MatrizResumo> {
  // Janela por `dia` (date). Expressao constante (sem input) -> sem injection.
  const todaySql = `(now() AT TIME ZONE 'America/Sao_Paulo')::date`;
  const sinceSql =
    period === 'today' ? todaySql
    : period === '7d' ? `(${todaySql} - 6)`
    : period === '30d' ? `(${todaySql} - 29)`
    : `date_trunc('month', ${todaySql})::date`;

  let metrics: Record<string, unknown> | null = null;
  let series: unknown[] = [];
  let leads: unknown[] = [];

  try {
    const r = await dbPool.query(
      `SELECT
         COALESCE(sum(conversas_total), 0)::int AS conversas,
         COALESCE(sum(fecharam), 0)::int AS fecharam,
         COALESCE(sum(escalaram), 0)::int AS escalaram,
         COALESCE(sum(abandonaram), 0)::int AS abandonaram,
         COALESCE(sum(faturamento), 0)::numeric AS faturamento,
         COALESCE(sum(custo_bot_brl), 0)::numeric AS custo_bot,
         CASE WHEN sum(conversas_total) > 0
              THEN round(100.0 * sum(fecharam) / sum(conversas_total), 1)
              ELSE 0 END AS taxa_conversao,
         CASE WHEN sum(fecharam) > 0
              THEN round(sum(faturamento) / sum(fecharam), 2)
              ELSE 0 END AS ticket_medio
       FROM analytics.v_daily_metrics
       WHERE environment = $1 AND dia >= ${sinceSql}`,
      [environment],
    );
    metrics = r.rows[0] ?? null;
  } catch { /* bloco vazio se a view faltar */ }

  try {
    const r = await dbPool.query(
      `SELECT dia,
              conversas_total::int AS conversas,
              fecharam::int AS fecharam,
              faturamento::numeric AS faturamento,
              custo_bot_brl::numeric AS custo_bot
       FROM analytics.v_daily_metrics
       WHERE environment = $1 AND dia >= ${sinceSql}
       ORDER BY dia`,
      [environment],
    );
    series = r.rows;
  } catch { /* bloco vazio */ }

  try {
    const r = await dbPool.query(
      `SELECT cliente_nome, cliente_telefone, moto, bairro, ultimo_preco_cotado,
              etapa_atingida, provavel_motivo, horas_sem_resposta::numeric AS horas,
              reclamou_preco, mencionou_concorrente
       FROM analytics.v_clientes_pra_recuperar
       WHERE environment = $1
       ORDER BY started_at DESC NULLS LAST
       LIMIT 12`,
      [environment],
    );
    leads = r.rows;
  } catch { /* bloco vazio */ }

  return { metrics, series, leads };
}
