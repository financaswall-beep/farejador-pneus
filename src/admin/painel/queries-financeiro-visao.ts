// Obra 300 (2026-07-05): fatia do banco da MATRIZ — visão consolidada do Financeiro da matriz (só leitura).
// VERBATIM das linhas 2208-2441 do queries.ts pré-obra (commit 2628748).
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
import { getWholesaleResumo, getVarejoResumo } from './queries-galpao.js';
import { getWholesaleFinance, getMatrizExpenses } from './queries-fiado-despesas.js';
import { getCommissionLedger } from './queries-comissoes.js';
import { getMatrizFinancialTruth, type MatrizFinancialTruth } from './queries-financeiro-verdade.js';

export interface FinanceiroReceivableItem {
  tipo: 'fiado' | 'comissao';
  id: string;                 // order id (fiado) ou partner_id (comissao)
  nome: string;
  valor: string;
  due_date: string | null;    // comissão acumulada não tem vencimento
  overdue: boolean;
  phone: string | null;       // deep-link wa.me "Cobrar"
  count?: number;             // comissão: nº de lançamentos em aberto
}

export interface FinanceiroPayableItem {
  tipo: 'fornecedor' | 'despesa' | 'folha';
  id: string;
  nome: string;
  categoria?: string;         // despesa: categoria (pro rótulo da agenda)
  valor: string;
  due_date: string | null;
  overdue: boolean;
}

export interface FinanceiroVisao {
  fontes: { fiado: boolean; comissao: boolean; despesas: boolean };
  verdade: MatrizFinancialTruth;
  mes: {
    faturamento: string;      // pernas somadas + frete de entrega (recorte mês São Paulo, régua 0117)
    custo: string;            // custo do pneu vendido (atacado + varejo congelado)
    despesas: string | null;  // ocorridas no mês (competência); null = flag off
    lucro: string;            // faturamento − custo − despesas(0 se off)
    margem_pct: number | null;
    itens_sem_custo: number;  // varejo sem custo congelado → aviso de honestidade
    pernas: {
      atacado: { faturamento: string; lucro: string };
      varejo: { faturamento: string; lucro: string };
      comissao: { realizado: string } | null;
      // Frete de ENTREGA da main (auditoria 07-08): a gasolina da rota já descontava
      // nas despesas (0120) mas a receita do frete não somava — o lucro mentia pra
      // baixo. Régua da Logística: GREATEST(total − itens, 0); janela do varejo.
      frete: { recebido: string };
    };
    despesas_categoria: Array<{ category: string; total: string }> | null;
  };
  a_receber: { total: string; vencidos_count: number; itens: FinanceiroReceivableItem[] };
  a_pagar: { total: string; vencidos_count: number; itens: FinanceiroPayableItem[] };
  indicadores: {
    capital_parado: string;   // Σ qty × custo médio do galpão
    pneus_galpao: number;
    giro_dias: number | null;         // capital / (custo vendido em 30d móveis / 30)
    giro_vezes: number | null;        // custo vendido em 30d / capital = quantas vezes o galpão girou (mesma base do giro_dias)
    fiado_aberto_pct: number | null;  // % do faturamento do atacado do mês ainda pendente (clamp 100)
    ponto_equilibrio: number | null;  // despesas do mês / margem bruta do mês
  };
}

/** Visão consolidada do Financeiro da matriz (Onda 1). Leitura pura das fontes
 *  existentes; derivados calculados AQUI (não na UI) pra prova de integração cravar. */
export async function getMatrizFinanceiroVisao(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<FinanceiroVisao> {
  const mesWhere = `>= date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')`;
  const [atacado, varejo, fiado, despesas, ledger, comissaoMes, fiadoAbertoMes, capital, despCat, custo30d, freteMes, verdade] =
    await Promise.all([
      getWholesaleResumo(environment, dbPool, 'mes'),
      getVarejoResumo('mes', environment, dbPool),
      env.WHOLESALE_FINANCE ? getWholesaleFinance(environment, dbPool) : Promise.resolve(null),
      env.MATRIZ_EXPENSES ? getMatrizExpenses(environment, dbPool) : Promise.resolve(null),
      env.NETWORK_COMMISSION_LEDGER ? getCommissionLedger(environment, dbPool) : Promise.resolve(null),
      env.NETWORK_COMMISSION_LEDGER
        ? dbPool.query<{ realizado: string }>(
            `SELECT COALESCE(SUM(commission_amount), 0) AS realizado
               FROM network.commission_entries
              WHERE environment = $1 AND status <> 'reversed'
                AND (realized_at AT TIME ZONE 'America/Sao_Paulo') ${mesWhere}`,
            [environment],
          ).then((r) => r.rows[0]!.realizado)
        : Promise.resolve(null),
      // Fiado do mês em aberto: soma dos ITENS (line_total) das vendas confirmed pending —
      // a MESMA base do denominador (faturamento do atacado = SUM(oi.line_total) do getWholesaleResumo).
      // Antes somava o header (total_amount) contra itens no denominador → venda sem item
      // estourava o % (500%). Agora numerador e denominador batem; clamp em 100 no cálculo.
      env.WHOLESALE_FINANCE
        ? dbPool.query<{ aberto: string }>(
            `SELECT COALESCE(SUM(oi.line_total), 0) AS aberto
               FROM commerce.wholesale_orders o
               JOIN commerce.wholesale_order_items oi
                 ON oi.order_id = o.id AND oi.environment = o.environment
              WHERE o.environment = $1 AND o.status = 'confirmed' AND o.payment_status = 'pending'
                AND (o.created_at AT TIME ZONE 'America/Sao_Paulo') ${mesWhere}`,
            [environment],
          ).then((r) => r.rows[0]!.aberto)
        : Promise.resolve(null),
      dbPool.query<{ capital: string; pneus: number }>(
        `SELECT COALESCE(SUM(quantity_on_hand * unit_cost), 0) AS capital,
                COALESCE(SUM(quantity_on_hand), 0)::int AS pneus
           FROM commerce.wholesale_stock WHERE environment = $1`,
        [environment],
      ).then((r) => r.rows[0]!),
      env.MATRIZ_EXPENSES
        ? dbPool.query<{ category: string; total: string }>(
            `SELECT category, SUM(amount) AS total
               FROM commerce.matriz_expenses
              WHERE environment = $1 AND deleted_at IS NULL
                AND (occurred_at AT TIME ZONE 'America/Sao_Paulo') ${mesWhere}
              GROUP BY category ORDER BY SUM(amount) DESC`,
            [environment],
          ).then((r) => r.rows)
        : Promise.resolve(null),
      // Custo do pneu vendido nos ÚLTIMOS 30 DIAS (janela móvel) — base do GIRO. Mês-calendário
      // encolhe o denominador no dia 2 e o giro estoura; a janela de 30d corridos é estável e
      // é o padrão de mercado. Atacado (unit_cost congelado) + varejo da main (matriz_unit_cost).
      dbPool.query<{ custo: string }>(
        `SELECT
           (SELECT COALESCE(SUM(oi.unit_cost * oi.quantity), 0)
              FROM commerce.wholesale_orders o
              JOIN commerce.wholesale_order_items oi
                ON oi.order_id = o.id AND oi.environment = o.environment
             WHERE o.environment = $1 AND o.status = 'confirmed'
               AND o.created_at >= now() - interval '30 days')
         + (SELECT COALESCE(SUM(oi.matriz_unit_cost * oi.quantity), 0)
              FROM commerce.orders o
              JOIN core.units u ON u.id = o.unit_id AND u.environment = o.environment AND u.slug = 'main'
              JOIN commerce.order_items oi ON oi.order_id = o.id AND oi.environment = o.environment
             WHERE o.environment = $1 AND o.status <> 'cancelled'
               AND o.created_at >= now() - interval '30 days')
           AS custo`,
        [environment],
      ).then((r) => r.rows[0]!.custo),
      // FRETE DE ENTREGA da main no mês (auditoria 07-08): total − itens por pedido
      // (o bot embute o frete no total; GREATEST clampa walk-in/desconto em 0 — régua
      // idêntica à da Logística), janela e cancelado na MESMA régua da perna do varejo.
      dbPool.query<{ frete: string }>(
        `SELECT COALESCE(SUM(GREATEST(o.total_amount - itens.s, 0)), 0) AS frete
           FROM commerce.orders o
           JOIN core.units u ON u.id = o.unit_id AND u.environment = o.environment AND u.slug = 'main'
           JOIN LATERAL (
             SELECT COALESCE(SUM(oi.quantity * oi.unit_price - oi.discount_amount), 0) AS s
               FROM commerce.order_items oi
              WHERE oi.order_id = o.id AND oi.environment = o.environment) itens ON true
          WHERE o.environment = $1 AND o.status <> 'cancelled' AND o.fulfillment_mode = 'delivery'
            AND (o.created_at AT TIME ZONE 'America/Sao_Paulo') ${mesWhere}`,
        [environment],
      ).then((r) => r.rows[0]!.frete),
      getMatrizFinancialTruth(environment, dbPool),
    ]);

  // Consolidado do mês (competência): faturou − custo do pneu − despesa ocorrida.
  // Frete entra CHEIO no lucro (não tem custo de pneu; o custo dele — gasolina da
  // rota — já desconta na perna das despesas).
  const comissaoRealizada = comissaoMes ? Number(comissaoMes) : 0;
  const freteRecebido = Number(freteMes);
  const faturamento = Number(atacado.faturamento) + Number(varejo.faturamento) + comissaoRealizada + freteRecebido;
  const custo = Number(atacado.custo_total) + Number(varejo.custo_total);
  const despesasMes = despCat ? despCat.reduce((s, c) => s + Number(c.total), 0) : null;
  const lucroBruto = Number(atacado.lucro_total) + Number(varejo.lucro_total) + comissaoRealizada + freteRecebido;
  const lucro = lucroBruto - (despesasMes ?? 0);
  const margemPct = faturamento > 0 ? Math.round((lucro / faturamento) * 1000) / 10 : null;

  // A RECEBER: fiado do atacado (linha a linha) + comissão acumulada por parceiro.
  const recebiveis: FinanceiroReceivableItem[] = [];
  if (fiado) {
    for (const r of fiado.receivables) {
      recebiveis.push({ tipo: 'fiado', id: r.id, nome: r.counterparty, valor: r.total_amount,
        due_date: r.due_date, overdue: r.overdue, phone: r.phone });
    }
  }
  if (ledger) {
    for (const p of ledger.partners) {
      recebiveis.push({ tipo: 'comissao', id: p.partner_id, nome: p.partner_name,
        valor: p.open_total, due_date: null, overdue: false, phone: p.whatsapp_phone,
        count: p.open_count });
    }
  }
  recebiveis.sort((a, b) => Number(b.overdue) - Number(a.overdue) || Number(b.valor) - Number(a.valor));

  // A PAGAR (agenda): vencido primeiro, depois vencimento mais perto, sem data no fim.
  const pagaveis: FinanceiroPayableItem[] = [];
  if (fiado) {
    for (const p of fiado.payables) {
      pagaveis.push({ tipo: 'fornecedor', id: p.id, nome: p.counterparty, valor: p.total_amount,
        due_date: p.due_date, overdue: p.overdue });
    }
  }
  if (despesas) {
    for (const d of despesas.entries) {
      if (d.payment_status !== 'pending') continue;
      pagaveis.push({ tipo: d.payroll_item_id ? 'folha' : 'despesa', id: d.id, nome: d.description || d.category,
        categoria: d.category, valor: d.amount, due_date: d.due_date, overdue: d.overdue });
    }
  }
  pagaveis.sort((a, b) => {
    if (a.overdue !== b.overdue) return Number(b.overdue) - Number(a.overdue);
    if (!a.due_date && !b.due_date) return Number(b.valor) - Number(a.valor);
    if (!a.due_date) return 1;
    if (!b.due_date) return -1;
    return a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0;
  });

  // Indicadores de dono. Guardas honestas: sem base → null (a UI mostra "—", não chuta).
  const capitalParado = Number(capital.capital);
  // Giro na janela móvel de 30 dias (não mês-calendário) → estável no começo do mês.
  // Galpão zerado → null ("—"): "0 dias" é ruído, não informação (auditoria 07-08).
  const custoJanela = Number(custo30d);
  const giroDias = capitalParado > 0 && custoJanela > 0
    ? Math.round(capitalParado / (custoJanela / 30)) : null;
  // Giro em VEZES (mesma base, inverso × 30): quanto o galpão girou em 30 dias.
  // 480k vendidos ÷ 186k parado = 2,58x. O card da tela nova mostra isto.
  const giroVezes = capitalParado > 0 && custoJanela > 0
    ? Math.round((custoJanela / capitalParado) * 100) / 100 : null;
  const fatAtacado = Number(atacado.faturamento);
  // Mesma base (line_total) nos dois lados + clamp em 100 (nunca > 100% do faturamento).
  const fiadoAbertoPct = fiadoAbertoMes !== null && fatAtacado > 0
    ? Math.min(100, Math.round((Number(fiadoAbertoMes) / fatAtacado) * 100)) : null;
  const margemBrutaFrac = faturamento > 0 ? lucroBruto / faturamento : 0;
  const pontoEquilibrio = despesasMes !== null && despesasMes > 0 && margemBrutaFrac > 0
    ? Math.round(despesasMes / margemBrutaFrac) : null;

  return {
    verdade,
    fontes: {
      fiado: Boolean(env.WHOLESALE_FINANCE),
      comissao: Boolean(env.NETWORK_COMMISSION_LEDGER),
      despesas: Boolean(env.MATRIZ_EXPENSES),
    },
    mes: {
      faturamento: faturamento.toFixed(2),
      custo: custo.toFixed(2),
      despesas: despesasMes !== null ? despesasMes.toFixed(2) : null,
      lucro: lucro.toFixed(2),
      margem_pct: margemPct,
      itens_sem_custo: varejo.itens_sem_custo,
      pernas: {
        atacado: { faturamento: atacado.faturamento, lucro: atacado.lucro_total },
        varejo: { faturamento: varejo.faturamento, lucro: varejo.lucro_total },
        comissao: comissaoMes !== null ? { realizado: Number(comissaoMes).toFixed(2) } : null,
        frete: { recebido: freteRecebido.toFixed(2) },
      },
      despesas_categoria: despCat,
    },
    a_receber: {
      total: ((fiado ? Number(fiado.a_receber_total) : 0) + (ledger ? Number(ledger.total_aberto) : 0)).toFixed(2),
      vencidos_count: fiado ? fiado.a_receber_vencidos : 0,
      itens: recebiveis,
    },
    a_pagar: {
      total: ((fiado ? Number(fiado.a_pagar_total) : 0) + (despesas ? Number(despesas.a_pagar_total) : 0)).toFixed(2),
      vencidos_count: (fiado ? fiado.a_pagar_vencidos : 0) + (despesas ? despesas.a_pagar_vencidos : 0),
      itens: pagaveis,
    },
    indicadores: {
      capital_parado: capitalParado.toFixed(2),
      pneus_galpao: capital.pneus,
      giro_dias: giroDias,
      giro_vezes: giroVezes,
      fiado_aberto_pct: fiadoAbertoPct,
      ponto_equilibrio: pontoEquilibrio,
    },
  };
}

// ─── LOGÍSTICA DA MATRIZ (0121) — entregas da 'main' + diário de rota ─────────
// Espelho do parceiro (0068/0069) no pedido da MATRIZ: em separação → saiu →
// entregue / não entregue. Decisões do dono 07-03: diário por SAÍDA (rota com
// km inicial/final + gasolina + comprovantes; as entregas penduram na rota).
// Termômetro NÃO mexe na régua de faturamento (0117 conta não-cancelado);
// "não entregue" CANCELA no caminho atômico (galpão volta pela trilha fdd9148).
// Guard em toda escrita: só pedido de ENTREGA da unit 'main' (parceiro intocado).
