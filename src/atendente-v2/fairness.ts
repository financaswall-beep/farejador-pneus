/**
 * Régua de justiça da Rede (Fase 2 — camada 2: RANKING).
 *
 * Ver:
 *  - docs/FASE2_MOTOR_DISTRIBUICAO_2026-06-06.md §4 (critérios) e §5 (decisões).
 *  - docs/PLANO_CONFIG_LOJA_E_ROTEAMENTO_REDE_2026-06-05.md §3.3.
 *
 * FUNÇÃO PURA — de propósito. Recebe os candidatos JÁ FILTRADOS (cobrem a área,
 * têm o produto em estoque, modo compatível) com a contagem de leads recebidos
 * na janela, e devolve a ordem de preferência: **quem a Rede acionou MENOS vai
 * primeiro**. Não toca banco, não lê o relógio (o "agora" é injetado), não sorteia.
 * Mesmas entradas → mesma ordem (reproduzível em prova/shadow).
 *
 * Decisões do Wallace (2026-06-05):
 *  - #2 janela = 7 dias. (A contagem do lead vem de fora; aqui só chega o número.)
 *  - #3 empurrão do novato = SUAVE: entra semeado na MEDIANA dos veteranos
 *    (COLD_START_FATOR = 1.0), com TETO, pra disputar igual — sem afogar o
 *    veterano (entrar em 0 e varrer tudo) nem ser esquecido (entrar alto demais).
 *
 * Anti-trapaça: a base é LEAD RECEBIDO (oportunidade), não venda. Isso é
 * responsabilidade de QUEM CONTA o lead (a fonte que produz `leadCount`); esta
 * função só ordena números.
 */

import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';

export interface FairnessCandidate {
  /** id da unidade — network.partner_units.id. */
  unitId: string;
  /** Leads recebidos na janela (ex.: COUNT de partner_orders 2w em 7d). */
  leadCount: number;
  /** Quando a unidade entrou na Rede — desempate estável + detecção de novato. */
  unitCreatedAt: Date;
  /** Último lead recebido (anti-seca no desempate); null = nunca recebeu. */
  lastLeadAt: Date | null;
}

export interface FairnessParams {
  /** "Agora" injetado (determinismo; nunca lê o relógio aqui dentro). */
  now: Date;
  /** Janela da contagem, em dias (decisão #2 = 7). Define quem é novato. */
  windowDays: number;
  /** Multiplicador da semente do novato sobre a mediana (decisão #3 = 1.0). */
  coldStartFactor: number;
  /**
   * Teto da semente do novato, como fração do MAIOR leadCount entre os veteranos.
   * Evita que uma mediana distorcida semeie o novato acima da galera.
   * 1.0 = a semente nunca passa do veterano mais acionado. Calibrável no `test`.
   */
  seedCapFactor: number;
}

/** Defaults travados (decisões #2/#3). `seedCapFactor` é o que vamos calibrar no `test`. */
export const DEFAULT_FAIRNESS_PARAMS: Omit<FairnessParams, 'now'> = {
  windowDays: 7,
  coldStartFactor: 1.0,
  seedCapFactor: 1.0,
};

export interface RankedCandidate extends FairnessCandidate {
  /** Crédito efetivo no ranking: leadCount real, ou semente + leadCount se novato. */
  credit: number;
  /** Entrou na Rede dentro da janela → recebeu a semente de cold-start. */
  isNewcomer: boolean;
}

/** Mediana de uma lista (vazia → 0; par → média dos dois centrais). */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Ordena candidatos pela régua de justiça. NÃO muta a entrada.
 *
 * Crédito (menor = atendido primeiro):
 *  - veterano: `credit = leadCount`.
 *  - novato (entrou dentro da janela): `credit = seed + leadCount`, onde
 *    `seed = min(mediana_dos_veteranos × coldStartFactor, maxVeterano × seedCapFactor)`.
 *    Sem veteranos → seed = 0 (todos disputam por desempate).
 *
 * Desempate determinístico (em ordem):
 *  credit ASC → lastLeadAt ASC NULLS FIRST (anti-seca) → unitCreatedAt ASC → unitId ASC.
 */
export function rankCandidatesByFairness(
  candidates: FairnessCandidate[],
  params: FairnessParams,
): RankedCandidate[] {
  if (candidates.length <= 1) {
    return candidates.map((c) => ({
      ...c,
      isNewcomer: c.unitCreatedAt.getTime() > params.now.getTime() - params.windowDays * 86_400_000,
      credit: c.leadCount,
    }));
  }

  const windowStartMs = params.now.getTime() - params.windowDays * 86_400_000;
  const veteranLeads = candidates
    .filter((c) => c.unitCreatedAt.getTime() <= windowStartMs)
    .map((c) => c.leadCount);

  const med = median(veteranLeads);
  const maxVeteran = veteranLeads.length ? Math.max(...veteranLeads) : 0;
  // Semente capada: nunca acima do veterano mais acionado (com seedCapFactor=1.0).
  const seed = Math.min(med * params.coldStartFactor, maxVeteran * params.seedCapFactor);

  const ranked: RankedCandidate[] = candidates.map((c) => {
    const isNewcomer = c.unitCreatedAt.getTime() > windowStartMs;
    return {
      ...c,
      isNewcomer,
      credit: isNewcomer ? seed + c.leadCount : c.leadCount,
    };
  });

  ranked.sort((a, b) => {
    if (a.credit !== b.credit) return a.credit - b.credit;
    // lastLeadAt ASC NULLS FIRST: quem nunca recebeu (ou recebeu há mais tempo) vai primeiro.
    const at = a.lastLeadAt ? a.lastLeadAt.getTime() : -Infinity;
    const bt = b.lastLeadAt ? b.lastLeadAt.getTime() : -Infinity;
    if (at !== bt) return at - bt;
    if (a.unitCreatedAt.getTime() !== b.unitCreatedAt.getTime()) {
      return a.unitCreatedAt.getTime() - b.unitCreatedAt.getTime();
    }
    return a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0;
  });

  return ranked;
}

// ─── FONTE DE CONTAGEM (I/O) ─────────────────────────────────────────────────
// A régua acima é pura. Aqui mora a parte que vai ao banco: conta o LEAD de cada
// candidato e devolve a ordem da régua. Imports são type-only (PoolClient,
// Environment) → este módulo continua sem efeito de runtime e testável isolado.

interface FairnessRow {
  unit_id: string;
  unit_created_at: Date;
  lead_count: string; // count() volta como string (bigint)
  last_lead_at: Date | null;
}

export interface FairnessFromDbOpts {
  /** "Agora" — default new Date(); injetável pra determinismo. */
  now?: Date;
  windowDays?: number;
  coldStartFactor?: number;
  seedCapFactor?: number;
}

/**
 * Conta os leads recebidos por cada unidade candidata e devolve os `unit_id`
 * REORDENADOS pela régua de justiça. Não escreve nada.
 *
 * LEAD = pedido do bot: `commerce.partner_orders` com `source_tag='2w'`,
 * `status <> 'cancelled'`, `deleted_at IS NULL`, `created_at` dentro da janela.
 * É a MESMA fatia que a cobrança da matriz usa (source_tag='2w') — mas contada
 * por `created_at`, NÃO por `delivered_at`: a régua mede a OPORTUNIDADE recebida
 * (anti-trapaça, o parceiro não controla quando o lead chega), não a venda
 * realizada. Decisão do keystone (2026-06-06): conta o pedido criado.
 *
 * `<= 1` candidato → devolve como veio, sem ir ao banco.
 */
export async function rankUnitsByFairnessFromDb(
  client: PoolClient,
  environment: Environment,
  candidateUnitIds: string[],
  opts: FairnessFromDbOpts = {},
): Promise<string[]> {
  if (candidateUnitIds.length <= 1) return [...candidateUnitIds];

  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? DEFAULT_FAIRNESS_PARAMS.windowDays;

  const r = await client.query<FairnessRow>(
    `SELECT pu.unit_id            AS unit_id,
            pu.created_at         AS unit_created_at,
            count(po.id)          AS lead_count,
            max(po.created_at)    AS last_lead_at
       FROM network.partner_units pu
       LEFT JOIN commerce.partner_orders po
         ON po.environment = pu.environment
        AND po.unit_id = pu.unit_id
        AND po.source_tag = '2w'
        AND po.status <> 'cancelled'
        AND po.deleted_at IS NULL
        AND po.created_at >= $2::timestamptz - make_interval(days => $3::int)
      WHERE pu.environment = $1
        AND pu.unit_id = ANY($4::uuid[])
      GROUP BY pu.unit_id, pu.created_at`,
    [environment, now.toISOString(), windowDays, candidateUnitIds],
  );

  const byId = new Map<string, FairnessCandidate>();
  for (const row of r.rows) {
    byId.set(row.unit_id, {
      unitId: row.unit_id,
      leadCount: Number(row.lead_count),
      unitCreatedAt: new Date(row.unit_created_at),
      lastLeadAt: row.last_lead_at ? new Date(row.last_lead_at) : null,
    });
  }

  // Mantém só os candidatos pedidos; preserva a ordem da régua. Candidato sem
  // linha (não esperado — são partner_units ativos) é descartado, defensivo.
  const candidates = candidateUnitIds
    .map((id) => byId.get(id))
    .filter((c): c is FairnessCandidate => c != null);

  const ranked = rankCandidatesByFairness(candidates, {
    now,
    windowDays,
    coldStartFactor: opts.coldStartFactor ?? DEFAULT_FAIRNESS_PARAMS.coldStartFactor,
    seedCapFactor: opts.seedCapFactor ?? DEFAULT_FAIRNESS_PARAMS.seedCapFactor,
  });

  return ranked.map((c) => c.unitId);
}
