import { AsyncLocalStorage } from 'node:async_hooks';
import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';
import { logger } from '../shared/logger.js';

interface Product { id: string; measure: string; matrixAvailable: number | null }
interface Store { id: string; name: string; quantities: ReadonlyMap<string, number> }
interface Trace { products: Product[]; stores: Store[]; municipality: string | null }
const context = new AsyncLocalStorage<Trace>();

// Os observadores só copiam resultados já lidos. Nunca mudam o roteamento ou o retorno da tool.
export function observeSearchProducts(products: Product[]): void {
  const trace = context.getStore();
  if (trace) trace.products = products.filter(p => p.measure?.trim()).map(p => ({
    ...p, measure: p.measure.trim().toUpperCase(),
  }));
}
export function observeSearchMunicipality(municipality: string | null): void {
  const trace = context.getStore();
  if (trace) trace.municipality = municipality;
}
export function observeSearchStore(id: string, name: string, quantities: ReadonlyMap<string, number>): void {
  context.getStore()?.stores.push({ id, name, quantities: new Map(quantities) });
}

export function buildSearchObservations(trace: Trace) {
  return [...new Set(trace.products.map(p => p.measure))].map(measure => {
    const products = trace.products.filter(p => p.measure === measure);
    const stores = trace.stores.map(store => ({
      id: store.id, name: store.name, kind: 'partner',
      available: products.some(p => (store.quantities.get(p.id) ?? 0) > 0),
    }));
    // A fonte legada pode representar a rede: só atribuir à Matriz quando a fonte for explícita.
    if (products.every(p => p.matrixAvailable !== null)) stores.push({
      id: 'matriz', name: 'Matriz', kind: 'matrix',
      available: products.some(p => (p.matrixAvailable ?? 0) > 0),
    });
    return { measure, stores };
  }).filter(row => row.stores.length > 0);
}

export async function withStockSearchTrace(
  client: PoolClient, environment: Environment, conversationId: string,
  input: { key: string; tool: string; args: Record<string, unknown>; messageId?: string }, execute: () => Promise<string>,
): Promise<string> {
  if (!['buscar_produto', 'buscar_compatibilidade'].includes(input.tool)) return execute();
  const trace: Trace = { products: [], stores: [], municipality: null };
  return context.run(trace, async () => {
    const result = await execute();
    try {
      const parsed = JSON.parse(result);
      if (parsed.erro || parsed.error) return result;
      const rows = buildSearchObservations(trace);
      if (!rows.length) return result;
      const filters = Object.fromEntries(['marca','condicao_pneu','posicao_pneu']
        .filter(key => typeof input.args[key] === 'string').map(key => [key, input.args[key]]));
      await client.query(
        `INSERT INTO ops.bot_stock_searches
          (environment,conversation_id,search_key,tool_name,measure,municipality,filters,stores,trigger_message_id)
         SELECT $1::env_t,$2::uuid,$3,$4,r.measure,$5,$6::jsonb,r.stores,$8::uuid
         FROM jsonb_to_recordset($7::jsonb) AS r(measure text,stores jsonb)
         WHERE EXISTS (SELECT 1 FROM core.conversations WHERE id=$2::uuid AND environment=$1::text)
         ON CONFLICT(environment,search_key,measure) DO NOTHING`,
        [environment,conversationId,input.key,input.tool,trace.municipality,JSON.stringify(filters),JSON.stringify(rows),input.messageId ?? null],
      );
    } catch (err) {
      // Executado somente nas tools de leitura, fora da transação de criar_pedido.
      // Uma falha de observabilidade não pode impedir a resposta normal do bot.
      logger.warn({ err, environment }, 'stock_search_trace_unavailable');
    }
    return result;
  });
}
