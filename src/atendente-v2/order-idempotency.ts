import { createHash } from 'node:crypto';

/** Item do pedido para a impressão digital (estrutural — casa com PedidoItem do tools.ts). */
export interface OrderFingerprintItem {
  product_id: string;
  quantidade: number;
  preco_unitario: number;
}

/**
 * Chave idempotente ESTÁVEL de um pedido do bot — impressão digital de
 * (conversa + loja + itens + modalidade). Em retry/dupla-chamada do MESMO pedido na
 * mesma conversa gera a MESMA chave → o índice parcial `orders_idempotency_key_uniq`
 * (+ ON CONFLICT DO NOTHING) dedup. Usada pelos DOIS caminhos do criar_pedido (parceiro
 * E matriz) — antes a matriz mandava NULL e duplicava (PED-0045/0046, Vitor Fernando 06-15).
 */
export function buildOrderIdempotencyKey(
  conversationId: string,
  unitId: string | null,
  itens: OrderFingerprintItem[],
  modalidade: string,
): string {
  return `bot:order:${conversationId}:${createHash('sha1')
    .update(JSON.stringify({ u: unitId, itens, modalidade }))
    .digest('hex')
    .slice(0, 16)}`;
}
