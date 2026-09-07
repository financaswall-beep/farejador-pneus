import type { PoolClient } from 'pg';

interface MemoryFactRow {
  fact_key: string;
  fact_value: unknown;
  observed_at: Date | string | null;
}

const MEMORY_FACT_KEYS = [
  'moto_modelo_consultado',
  'moto_ano',
  'medida_pneu',
  'posicao_pneu',
  'produto_cotado',
  'preco_cotado',
  'modalidade_entrega',
  'bairro_canonico',
  'bairro_consultado',
  'municipio_entrega',
  'forma_pagamento',
  'pedido_numero',
  'pedido_total',
] as const;

const FACT_LABELS: Record<string, string> = {
  moto_modelo_consultado: 'moto consultada',
  moto_ano: 'ano informado',
  medida_pneu: 'medida do pneu',
  posicao_pneu: 'posição',
  produto_cotado: 'produto cotado',
  preco_cotado: 'preço cotado na época',
  modalidade_entrega: 'modalidade',
  bairro_canonico: 'bairro',
  bairro_consultado: 'bairro consultado',
  municipio_entrega: 'município',
  forma_pagamento: 'pagamento',
  pedido_numero: 'pedido anterior',
  pedido_total: 'total do pedido anterior',
};

function printableFact(value: unknown): string | null {
  if (typeof value === 'string') return value.trim().slice(0, 160) || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const candidate = value as Record<string, unknown>;
  for (const key of ['text', 'value', 'name', 'amount', 'size', 'model']) {
    const nested = candidate[key];
    if (typeof nested === 'string' && nested.trim()) return nested.trim().slice(0, 160);
    if (typeof nested === 'number') return String(nested);
  }
  return null;
}

export function formatCustomerMemory(rows: readonly MemoryFactRow[], memoryDays: number): string | null {
  const facts = rows.flatMap((row) => {
    const value = printableFact(row.fact_value);
    const label = FACT_LABELS[row.fact_key];
    return value && label ? [`${label}: ${value}`] : [];
  });
  if (facts.length === 0) return null;

  return `\n[MEMÓRIA COMERCIAL — últimos ${memoryDays} dias] Há contexto de conversa anterior deste mesmo contato: ${facts.join('; ')}. Use isso apenas para dar continuidade e evitar perguntas repetidas. NÃO diga que leu histórico, NÃO trate cotação ou pedido antigo como vigente e reconfirme intenção, estoque, preço, endereço e pagamento antes de qualquer novo fechamento.`;
}

/**
 * Memória curta entre conversas do mesmo contato. Lê somente facts analíticos
 * permitidos; não copia mensagens, anexos, coordenadas nem endereço completo.
 */
export async function loadCustomerMemory(
  client: PoolClient,
  conversationId: string,
  memoryDays: number,
): Promise<string | null> {
  if (memoryDays <= 0) return null;
  const result = await client.query<MemoryFactRow>(
    `WITH current_conversation AS (
       SELECT environment,contact_id
         FROM core.conversations
        WHERE id=$1 AND deleted_at IS NULL
     ), recent_facts AS (
       SELECT DISTINCT ON (f.fact_key)
              f.fact_key,f.fact_value,COALESCE(f.observed_at,f.created_at) AS observed_at
         FROM current_conversation current
         JOIN core.conversations prior
           ON prior.environment=current.environment
          AND prior.contact_id=current.contact_id
          AND prior.id<>$1
          AND prior.deleted_at IS NULL
          AND COALESCE(prior.last_activity_at,prior.started_at)>=now()-($2*interval '1 day')
         JOIN analytics.conversation_facts f
           ON f.environment=prior.environment
          AND f.conversation_id=prior.id
          AND f.superseded_by IS NULL
        WHERE current.contact_id IS NOT NULL
          AND f.fact_key=ANY($3::text[])
        ORDER BY f.fact_key,COALESCE(f.observed_at,f.created_at) DESC,f.created_at DESC,f.id DESC
     )
     SELECT fact_key,fact_value,observed_at
       FROM recent_facts
      ORDER BY observed_at DESC NULLS LAST,fact_key`,
    [conversationId, memoryDays, MEMORY_FACT_KEYS],
  );
  return formatCustomerMemory(result.rows, memoryDays);
}
