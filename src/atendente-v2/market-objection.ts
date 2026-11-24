import type { PoolClient } from 'pg';
import { z } from 'zod';
import { readApprovedMarketReference } from '../shared/catalog-market-reference.js';
import { env } from '../shared/config/env.js';
import type { Environment } from '../shared/types/chatwoot.js';
import { verifiedObjectionProduct } from './stock-group-offer.js';
import type { ToolDefinition } from './types.js';

export function isPriceObjection(message: string | null): boolean {
  if (!message) return false;
  const text = message.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  return text.split(/[,.!?;]|\b(?:mas|porem|contudo)\b/).some(clause => {
    if (/\b(?:nao|nem)\s+(?:achei|acho|considero|parece|esta|ta|e|ficou)\s+(?:muito\s+)?car[oa]\b/.test(clause)
      || /\bnao\s+(?:preciso|quero|necessito)\s+(?:de\s+)?desconto\b/.test(clause)) return false;
    const freight = /\b(?:frete|taxa de entrega)\b/.test(clause);
    const tireSubject = /(?:^|\b(?:o|a|esse|essa|este|esta|meu|minha)\s+)(?:pneus?|unidade|conjunto|jogo|par)\s+(?:ta|esta|e|ficou)\b/.test(clause.trim());
    if (freight && !tireSubject) return false;
    return /\b(?:car[oa]s?|mais barat[oa]s?|desconto|carissim[oa]|preco (?:muito )?alto|fora do meu orcamento)\b/.test(clause)
      || /\b(?:melhor[ae]?|abaix[ae]|baix[ae]|reduz(?:ir)?)\b.{0,25}\b(?:preco|valor)\b/.test(clause)
      || /\b(?:faz|fecha|consegue)\s+(?:por|a|nos)\s+(?:r\$\s*)?\d/.test(clause);
  });
}

export const MARKET_OBJECTION_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'consultar_referencia_preco',
    description: 'Consulta referência aprovada de pneu NOVO apenas ao responder uma objeção de preço do cliente sobre um produto exato já cotado na Matriz. Não é preço da loja e não concede desconto.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { product_id: { type: 'string', description: 'UUID do pneu já ofertado nesta conversa.' } },
      required: ['product_id'],
    },
  },
};

const input = z.object({ product_id: z.string().uuid() }).strict();

export async function lookupMarketObjection(
  client: PoolClient, environment: Environment, conversationId: string,
  triggerMessageId: string | undefined, args: Record<string, unknown>,
) {
  const parsed = input.safeParse(args);
  if (!env.MATRIZ_MARKET_REFERENCE_OBJECTIONS || !parsed.success || !triggerMessageId) return { referencia_disponivel: false };
  const message = await client.query<{ content: string | null }>(`
    SELECT content FROM core.messages
     WHERE id=$1 AND environment=$2 AND conversation_id=$3
       AND sender_type='contact' AND message_type=0 AND NOT is_private AND deleted_at IS NULL`,
  [triggerMessageId, environment, conversationId]);
  if (!isPriceObjection(message.rows[0]?.content ?? null)
    || !await verifiedObjectionProduct(client, environment, conversationId, triggerMessageId, parsed.data.product_id)) {
    return { referencia_disponivel: false };
  }
  const reference = await readApprovedMarketReference(client, environment, parsed.data.product_id);
  if (!reference) return { referencia_disponivel: false };
  return {
    referencia_disponivel: true, preco_online_novo: reference.amount, moeda: 'BRL',
    modelo: reference.model, data_da_consulta: reference.observed_on, tipo_da_referencia: reference.comparison,
    orientacao: 'Se a comparação ajudar a responder, informe a condição nova, o tipo da referência e a data. Mantenha o preço oficial do item da loja. Não compare estados iguais nem prometa desconto por causa desta referência.',
  };
}
