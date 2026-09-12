import type { Pool } from 'pg';
import { parseCatalogTireMeasure } from './catalog-tire-measure.js';

type Json = Record<string, unknown>;
export interface LeadQuote {
  product_id: string; product_name: string; brand: string | null; amount: number;
}
export interface LeadInterestVariant {
  key: string; condition: string | null; brand: string | null; position: string | null;
  quotes: LeadQuote[]; availability: 'available' | 'unavailable' | 'not_found' | 'unknown';
  stores: { id: string; name: string; available: boolean }[]; observed_at: string;
}
export interface LeadInterest { key: string; measure: string; variants: LeadInterestVariant[] }
export interface LeadInterestFact { fact_value: unknown }
export interface LeadInterestTurn {
  trigger_message_id: string | null; created_at: string; actions: unknown;
}
export interface LeadInterestSearch {
  trigger_message_id: string | null; measure: string; filters: unknown; stores: unknown;
}
const object = (value: unknown): Json => {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Json : {};
  } catch { return {}; }
};
const list = (value: unknown): Json[] => Array.isArray(value) ? value.map(object) : [];
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
function measure(value: unknown) {
  if (typeof value !== 'string') return null;
  const metric = value.trim().match(/^(\d{2,3})[\s/-]+(\d{2,3})[\s/R-]+(\d{2})$/i);
  return parseCatalogTireMeasure(metric ? `${metric[1]}/${metric[2]}-${metric[3]}` : value);
}
const condition = (value: unknown) => ['novo', 'meia_vida', 'remold'].includes(String(value)) ? String(value) : null;
const same = (a: string | null, b: string | null) => (a ?? '').toLocaleLowerCase('pt-BR') === (b ?? '').toLocaleLowerCase('pt-BR');
const number = (value: unknown): number => typeof value === 'number' ? value
  : typeof value === 'string' && /^\d+(\.\d+)?$/.test(value) ? Number(value) : NaN;
function* searchResults(value: unknown): Generator<{ args: Json; result: Json }> {
  const actions = list(value);
  const results = new Map(actions.filter(a => a.role === 'tool').map(a => [a.tool_call_id, object(a.content)]));
  for (const action of actions.filter(a => a.role === 'assistant')) for (const call of list(action.tool_calls)) {
    const fn = object(call.function), result = results.get(call.id), args = object(fn.arguments);
    if (!['buscar_produto', 'buscar_compatibilidade'].includes(String(fn.name)) || !result) continue;
    if (result.precisa_confirmar_modelo_versao || result.precisa_confirmar_ano || result.precisa_confirmar_posicao) continue;
    // A compatibilidade também pode executar buscas por medida internamente.
    const nested = list(result.consultas_estoque);
    if (nested.length) {
      for (const query of nested) yield { args: { ...args, medida_pneu: query.medida_pneu }, result: object(query.resultado) };
    } else {
      yield { args, result: { ...result, produtos: [...list(result.produtos), ...list(result.veiculos).flatMap(v => list(v.produtos))]
        .map(p => ({ ...p, price_amount: p.price_amount ?? p.current_price,
          total_stock_available: p.total_stock_available ?? p.total_stock })) } };
    }
  }
}

/** Projeção de leitura: o preço vem do próprio produto retornado pela tool,
 * nunca do fact preco_cotado solto ou do preço atual do catálogo. */
export function buildLeadInterests(
  facts: LeadInterestFact[], turns: LeadInterestTurn[], searches: LeadInterestSearch[],
): LeadInterest[] {
  const interests = new Map<string, LeadInterest>();
  function ensure(value: unknown) {
    const parsed = measure(value);
    if (!parsed) return null;
    if (!interests.has(parsed.key)) interests.set(parsed.key, { key: parsed.key, measure: parsed.canonical, variants: [] });
    return interests.get(parsed.key)!;
  }
  for (const turn of turns) {
    for (const {args, result} of searchResults(turn.actions)) {
      const requested = ensure(args.medida_pneu);
      if (!result || result.erro || result.error || result.precisa_municipio || result.precisa_localizacao) continue;
      const products = list(result.produtos);
      const measures = new Set([requested?.key, ...products.map(p => ensure(p.tire_size)?.key)].filter(Boolean));
      for (const key of measures) {
        const interest = interests.get(key!)!;
        const requestedCondition = condition(args.condicao_pneu), brand = text(args.marca), position = text(args.posicao_pneu);
        const candidates = products.filter(p => measure(p.tire_size)?.key === key);
        const conditions = new Set(candidates.map(p => condition(p.tire_condition) ?? requestedCondition));
        if (!conditions.size) conditions.add(requestedCondition);
        // Uma reconsulta ampla substitui a consulta anterior no mesmo escopo.
        // Uma consulta de novo não apaga o meia-vida, nem muda seu preço.
        interest.variants = interest.variants.filter(v => {
          if (requestedCondition && v.condition !== requestedCondition || position && v.position !== position) return true;
          if (!brand || same(v.brand, brand)) return false;
          v.quotes = v.quotes.filter(q => !same(q.brand, brand));
          return v.quotes.length > 0 || v.brand !== null;
        });
        const trace = [...searches].reverse().find(s => s.trigger_message_id !== null && s.trigger_message_id === turn.trigger_message_id
          && measure(s.measure)?.key === key && same(text(object(s.filters).marca), brand)
          && condition(object(s.filters).condicao_pneu) === requestedCondition
          && same(text(object(s.filters).posicao_pneu), position));
        const stores = list(trace?.stores).filter(s => typeof s.available === 'boolean' && text(s.id) && text(s.name))
          .map(s => ({ id: String(s.id), name: String(s.name), available: s.available as boolean }));
        for (const cond of conditions) {
          const group = candidates.filter(p => (condition(p.tire_condition) ?? requestedCondition) === cond);
          const available = group.filter(p => number(p.total_stock_available) > 0);
          const quotes = new Map<string, LeadQuote>();
          for (const p of available) {
            const amount = number(p.price_amount);
            if (!text(p.product_id) || !Number.isFinite(amount) || amount < 0 || (p.currency && p.currency !== 'BRL')) continue;
            if (requestedCondition && cond !== requestedCondition) continue;
            quotes.set(String(p.product_id), { product_id: String(p.product_id), product_name: text(p.product_name) ?? interest.measure,
              brand: text(p.brand), amount });
          }
          const missing = stores.length > 0 && stores.every(s => !s.available);
          interest.variants.push({ key: [cond, brand, position].join('|'), condition: cond, brand, position,
            quotes: missing ? [] : [...quotes.values()], stores, observed_at: turn.created_at,
            availability: missing ? 'unavailable' : available.length ? 'available'
              : result.encontrado === false && result.mensagem === 'Nenhum produto encontrado.' ? 'not_found'
                : group.length && group.every(p => number(p.total_stock_available) === 0) ? 'unavailable' : 'unknown' });
        }
      }
    }
  }
  for (const fact of facts) ensure(fact.fact_value);
  return [...interests.values()];
}

/** Lê em lote somente as conversas selecionadas pelo painel e no mesmo ambiente. */
export async function loadCustomerLeadInterests(environment: 'prod' | 'test', conversationIds: string[], db: Pool) {
  const ids = [...new Set(conversationIds.filter(Boolean))];
  const output = new Map<string, LeadInterest[]>();
  if (!ids.length) return output;
  const [facts, turns, searches] = await Promise.all([
    db.query<LeadInterestFact & { conversation_id: string }>(
      `SELECT f.conversation_id, f.fact_value FROM analytics.conversation_facts f
       JOIN core.conversations c ON c.id=f.conversation_id AND c.environment=f.environment AND c.deleted_at IS NULL
       WHERE f.environment=$1 AND f.conversation_id=ANY($2::uuid[]) AND f.superseded_by IS NULL
         AND f.fact_key IN ('medida_consultada','medida_pneu')
       ORDER BY COALESCE(f.observed_at,f.created_at), f.id`, [environment, ids]),
    db.query<LeadInterestTurn & { conversation_id: string }>(
      `SELECT t.conversation_id, t.trigger_message_id, t.created_at::text, t.actions FROM agent.turns t
       JOIN core.conversations c ON c.id=t.conversation_id AND c.environment=t.environment AND c.deleted_at IS NULL
       WHERE t.environment=$1 AND t.conversation_id=ANY($2::uuid[]) AND t.agent_version='v2'
         AND t.status IN ('sent_api_ack','delivered') AND jsonb_typeof(t.actions)='array'
       ORDER BY t.created_at, t.id`, [environment, ids]),
    db.query<LeadInterestSearch & { conversation_id: string }>(
      `SELECT s.conversation_id, s.trigger_message_id, s.measure, s.filters, s.stores FROM ops.bot_stock_searches s
       JOIN core.conversations c ON c.id=s.conversation_id AND c.environment=s.environment::text AND c.deleted_at IS NULL
       WHERE s.environment=$1 AND s.conversation_id=ANY($2::uuid[])
       ORDER BY s.occurred_at, s.id`, [environment, ids]),
  ]);
  for (const id of ids) output.set(id, buildLeadInterests(
    facts.rows.filter(r => r.conversation_id === id), turns.rows.filter(r => r.conversation_id === id),
    searches.rows.filter(r => r.conversation_id === id),
  ));
  return output;
}
