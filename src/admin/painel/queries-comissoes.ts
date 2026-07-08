// Obra 300 (2026-07-05): fatia do banco da MATRIZ — comissões como lançamento (0118): varredura, livro, quitar, termos.
// VERBATIM das linhas 2006-2207 do queries.ts pré-obra (commit 2628748).
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

export interface CommissionSweepResult {
  created: number;
  reversed: number;
}

/** VARRE e corrige o livro de comissões (idempotente):
 *  1) cria lançamento pra venda 2W REALIZADA sem lançamento (UNIQUE por venda segura retry);
 *  2) estorna lançamento vivo cuja venda foi cancelada/apagada — se já estava PAGO, vira
 *     'reversed' com settled_at preservado (trilha do "acerto por fora"). */
export async function sweepCommissionEntries(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<CommissionSweepResult> {
  const ins = await dbPool.query(
    `INSERT INTO network.commission_entries
       (environment, partner_id, partner_unit_id, unit_id, partner_order_id,
        order_total, commission_percent, commission_amount, realized_at)
     SELECT po.environment, pu.partner_id, pu.id, po.unit_id, po.id,
            GREATEST(po.total_amount - COALESCE(po.freight_amount, 0), 0), p.commission_percent,
            round(GREATEST(po.total_amount - COALESCE(po.freight_amount, 0), 0) * p.commission_percent / 100.0, 2),
            (CASE WHEN po.fulfillment_mode = 'delivery'
                  THEN COALESCE(po.delivered_at, po.created_at)
                  ELSE COALESCE(po.retrieved_at, po.created_at) END)
       FROM commerce.partner_orders po
       JOIN network.partner_units pu
         ON pu.unit_id = po.unit_id AND pu.environment = po.environment AND pu.deleted_at IS NULL
       JOIN network.partners p
         ON p.id = pu.partner_id AND p.environment = po.environment AND p.deleted_at IS NULL
      WHERE po.environment = $1
        AND po.source_tag = '2w'
        AND po.status <> 'cancelled' AND po.deleted_at IS NULL
        AND NOT (po.fulfillment_mode = 'delivery' AND po.delivery_status <> 'delivered')
        AND NOT po.awaiting_pickup
        AND p.commercial_model IN ('commission', 'hybrid')
        AND COALESCE(p.commission_percent, 0) > 0
     ON CONFLICT (environment, partner_order_id) DO NOTHING`,
    [environment],
  );

  const rev = await dbPool.query(
    `UPDATE network.commission_entries ce
        SET status = 'reversed', reversed_at = now(),
            reversed_reason = 'venda cancelada/desfeita'
      WHERE ce.environment = $1
        AND ce.status IN ('open', 'settled')
        AND (
          NOT EXISTS (SELECT 1 FROM commerce.partner_orders po
                       WHERE po.id = ce.partner_order_id AND po.environment = ce.environment)
          OR EXISTS (SELECT 1 FROM commerce.partner_orders po
                      WHERE po.id = ce.partner_order_id AND po.environment = ce.environment
                        AND (po.status = 'cancelled' OR po.deleted_at IS NOT NULL))
        )`,
    [environment],
  );

  return { created: ins.rowCount ?? 0, reversed: rev.rowCount ?? 0 };
}

export interface CommissionLedger {
  total_aberto: string;
  abertos_count: number;
  partners: Array<{
    partner_id: string;
    partner_name: string;
    whatsapp_phone: string | null;
    open_count: number;
    open_total: string;
  }>;
  entries: Array<{
    id: string;
    partner_name: string;
    order_total: string;
    commission_percent: string;
    commission_amount: string;
    status: 'open' | 'settled' | 'reversed';
    realized_at: string;
    settled_at: string | null;
    reversed_at: string | null;
  }>;
}

/** Livro de comissões pro painel: total em aberto, agregado por parceiro (de quem cobrar)
 *  e os últimos 25 lançamentos (vivos, recebidos e estornados — trilha visível). */
export async function getCommissionLedger(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<CommissionLedger> {
  const totals = await dbPool.query<{ total_aberto: string; abertos_count: number }>(
    `SELECT COALESCE(SUM(commission_amount), 0) AS total_aberto, COUNT(*)::int AS abertos_count
       FROM network.commission_entries WHERE environment = $1 AND status = 'open'`,
    [environment],
  );
  const partners = await dbPool.query(
    `SELECT ce.partner_id, COALESCE(p.trade_name, p.legal_name, 'Parceiro') AS partner_name,
            p.whatsapp_phone,
            COUNT(*)::int AS open_count, COALESCE(SUM(ce.commission_amount), 0) AS open_total
       FROM network.commission_entries ce
       JOIN network.partners p ON p.id = ce.partner_id AND p.environment = ce.environment
      WHERE ce.environment = $1 AND ce.status = 'open'
      GROUP BY ce.partner_id, p.trade_name, p.legal_name, p.whatsapp_phone
      ORDER BY open_total DESC`,
    [environment],
  );
  const entries = await dbPool.query(
    `SELECT ce.id, COALESCE(p.trade_name, p.legal_name, 'Parceiro') AS partner_name,
            ce.order_total, ce.commission_percent, ce.commission_amount,
            ce.status, ce.realized_at, ce.settled_at, ce.reversed_at
       FROM network.commission_entries ce
       JOIN network.partners p ON p.id = ce.partner_id AND p.environment = ce.environment
      WHERE ce.environment = $1
      ORDER BY ce.realized_at DESC
      LIMIT 25`,
    [environment],
  );
  return {
    total_aberto: totals.rows[0]!.total_aberto,
    abertos_count: totals.rows[0]!.abertos_count,
    partners: partners.rows as CommissionLedger['partners'],
    entries: entries.rows as CommissionLedger['entries'],
  };
}

/** "Recebi": quita TODOS os lançamentos em aberto de um parceiro (open → settled).
 *  Nada em aberto → nothing_open (não inventa quitação). */
export async function settleCommissionEntries(
  input: { partner_id: string; settled_by: string; environment?: 'prod' | 'test' },
  dbPool: Pool = defaultPool,
): Promise<{ settled_count: number; settled_total: string }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const r = await dbPool.query<{ commission_amount: string }>(
    `UPDATE network.commission_entries
        SET status = 'settled', settled_at = now(), settled_by = $3
      WHERE environment = $1 AND partner_id = $2 AND status = 'open'
      RETURNING commission_amount`,
    [environment, input.partner_id, input.settled_by],
  );
  if ((r.rowCount ?? 0) === 0) throw new Error('nothing_open');
  const total = r.rows.reduce((sum, row) => sum + Number(row.commission_amount), 0);
  return { settled_count: r.rowCount ?? 0, settled_total: total.toFixed(2) };
}

/** Editor do MODELO COMERCIAL do parceiro (pendência de 06-01): grava modelo + % +
 *  mensalidade na FICHA (network.partners) com trilha em audit.events. Vale pra
 *  lançamentos NOVOS — o que já foi lançado fica com o % da época (congelado, regra
 *  do dono). SEM flag: é edição de cadastro, aditiva. */
export async function updatePartnerCommercialTerms(
  input: {
    partner_id: string;
    commercial_model: 'commission' | 'monthly' | 'hybrid';
    commission_percent: number | null;
    monthly_fee: number | null;
    actor_label: string;
    environment?: 'prod' | 'test';
  },
  dbPool: Pool = defaultPool,
): Promise<{ updated: true }> {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  if (input.commission_percent !== null && (input.commission_percent < 0 || input.commission_percent > 100)) {
    throw new Error('invalid_percent');
  }
  if (input.monthly_fee !== null && input.monthly_fee < 0) throw new Error('invalid_fee');

  const before = await dbPool.query(
    `SELECT commercial_model, commission_percent, monthly_fee FROM network.partners
      WHERE id = $1 AND environment = $2 AND deleted_at IS NULL`,
    [input.partner_id, environment],
  );
  if (!before.rows[0]) throw new Error('partner_not_found');

  await dbPool.query(
    `UPDATE network.partners
        SET commercial_model = $3, commission_percent = $4, monthly_fee = $5, updated_at = now()
      WHERE id = $1 AND environment = $2 AND deleted_at IS NULL`,
    [input.partner_id, environment, input.commercial_model, input.commission_percent, input.monthly_fee],
  );
  await dbPool.query(
    `INSERT INTO audit.events (environment, domain, entity_table, entity_id, event_type, actor_label, idempotency_key, payload_after)
     VALUES ($1, 'network', 'network.partners', $2, 'partner_terms_updated', $3, $4, $5::jsonb)`,
    [environment, input.partner_id, input.actor_label, `terms-${input.partner_id}-${Date.now()}`,
     JSON.stringify({
       before: before.rows[0],
       after: {
         commercial_model: input.commercial_model,
         commission_percent: input.commission_percent,
         monthly_fee: input.monthly_fee,
       },
     })],
  );
  return { updated: true };
}

// ─── FINANCEIRO DA MATRIZ — VISÃO CONSOLIDADA (Onda 1: SÓ LEITURA) ────────────
// A tela Financeiro num payload só: consolidado do MÊS das 3 pernas (atacado +
// varejo 0117 + comissão 0118) menos as despesas (0120), A RECEBER e A PAGAR
// juntos (fiado 0115 + comissão + despesa pendente, agenda por vencimento) e os
// indicadores de dono (capital parado no galpão, giro, fiado em aberto, ponto de
// equilíbrio). ZERO escrita e ZERO migration: cada fatia respeita a flag da sua
// fonte — flag off → aquela fatia vem null/fora e a UI esconde. A varredura da
// comissão NÃO roda aqui de propósito (roda na PORTA: boot do painel, GET da
// Rede e — desde a auditoria 07-08 — GET do Financeiro; a visão continua leitura
// barata e sem efeito colateral, testável a seco).

