import type { PoolClient } from 'pg';
import type { ChatMessage } from './types.js';

/**
 * MEMÓRIA DE PRODUTO server-side (furo raiz da auditoria 2026-06-08).
 *
 * As ferramentas de FALA (localizacao_loja, calcular_frete) só decidem a loja certa
 * (estoque + proximidade + régua) quando o LLM passa o produto — e ele às vezes
 * esquece. Resultado: a fala diverge do pedido. Em vez de depender do LLM, lemos o
 * `product_id` que o PRÓPRIO bot já resolveu e gravou em `agent.turns.actions` (é JSON
 * que o bot gerou, NÃO texto do cliente — lógica, não regex). Assim a fala usa o mesmo
 * produto do pedido, sempre.
 *
 * Precedência (mais recente primeiro): produto ESCOLHIDO (itens do criar_pedido /
 * produtos do calcular_frete / product_ids de uma localizacao_loja anterior) vence a
 * busca; sem nada escolhido, pega o TOP da última busca (o pneu em discussão, não a
 * lista inteira — senão o pedido exigiria a loja ter todos os candidatos).
 */

const SEARCH_TOOLS = new Set(['buscar_produto', 'buscar_compatibilidade']);

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** product_ids dos ARGS de uma tool call (produto escolhido/confirmado). */
function idsFromToolArgs(name: string, argsJson: string): string[] {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsJson || '{}') as Record<string, unknown>;
  } catch {
    return [];
  }
  if (name === 'criar_pedido' && Array.isArray(args.itens)) {
    return (args.itens as Array<{ product_id?: unknown }>).map((i) => i?.product_id).filter((x): x is string => typeof x === 'string');
  }
  if (name === 'calcular_frete' && Array.isArray(args.produtos)) {
    return (args.produtos as Array<{ product_id?: unknown }>).map((p) => p?.product_id).filter((x): x is string => typeof x === 'string');
  }
  if (name === 'localizacao_loja') {
    return asStringArray(args.product_ids);
  }
  return [];
}

/** TOP product_id do RESULTADO de uma busca (o pneu em discussão). */
function idFromSearchResult(name: string, content: string | null): string[] {
  if (!content) return [];
  let r: Record<string, unknown>;
  try {
    r = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (name === 'buscar_produto' && Array.isArray(r.produtos)) {
    const ids = (r.produtos as Array<{ product_id?: unknown }>).map((p) => p?.product_id).filter((x): x is string => typeof x === 'string');
    return ids.length ? [ids[0]!] : [];
  }
  if (name === 'buscar_compatibilidade' && Array.isArray(r.veiculos)) {
    for (const v of r.veiculos as Array<{ produtos?: Array<{ product_id?: unknown }> }>) {
      const ids = (v?.produtos ?? []).map((p) => p?.product_id).filter((x): x is string => typeof x === 'string');
      if (ids.length) return [ids[0]!];
    }
  }
  return [];
}

/**
 * PURO (testável sem banco): dado o histórico de `actions` por turn, do mais RECENTE
 * pro mais antigo, devolve os product_ids do produto em discussão. Vazio = nada achado.
 */
export function extractRecentProductIds(turnsNewestFirst: ChatMessage[][]): string[] {
  for (const actions of turnsNewestFirst) {
    if (!Array.isArray(actions)) continue;
    // tool_call_id -> nome da tool (pra saber de qual busca veio o resultado).
    const nameById = new Map<string, string>();
    for (const m of actions) {
      if (m.role === 'assistant' && m.tool_calls) {
        for (const tc of m.tool_calls) nameById.set(tc.id, tc.function.name);
      }
    }
    // ações em ordem reversa (a mais recente do turn primeiro).
    for (let i = actions.length - 1; i >= 0; i--) {
      const m = actions[i]!;
      if (m.role === 'assistant' && m.tool_calls) {
        for (let j = m.tool_calls.length - 1; j >= 0; j--) {
          const tc = m.tool_calls[j]!;
          const ids = idsFromToolArgs(tc.function.name, tc.function.arguments);
          if (ids.length) return [...new Set(ids)].slice(0, 4);
        }
      } else if (m.role === 'tool' && m.tool_call_id) {
        const name = nameById.get(m.tool_call_id);
        if (name && SEARCH_TOOLS.has(name)) {
          const ids = idFromSearchResult(name, m.content);
          if (ids.length) return ids;
        }
      }
    }
  }
  return [];
}

/**
 * Lê os product_ids do produto em discussão na conversa (gravados em
 * `agent.turns.actions`). Usado por localizacao_loja/calcular_frete quando o LLM não
 * passou o produto. Sem efeito colateral (só SELECT). Vazio = nada gravado ainda.
 */
export async function getRecentProductIds(client: PoolClient, conversationId: string): Promise<string[]> {
  const r = await client.query<{ actions: ChatMessage[] | null }>(
    `SELECT actions
       FROM agent.turns
      WHERE conversation_id = $1
        AND agent_version = 'v2'
        AND actions IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 12`,
    [conversationId],
  );
  const turns = r.rows.map((row) => row.actions).filter((a): a is ChatMessage[] => Array.isArray(a));
  return extractRecentProductIds(turns);
}
