import type { ChatMessage, ToolCall } from './types.js';

function object(text: string | null): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text ?? 'null');
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : null;
  } catch { return null; }
}

function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

/** Destaque efêmero das ferramentas já presentes no histórico. Não interpreta
 * consentimento, não grava estado e não transforma uma foto em reserva. */
export function buildPurchaseContext(history: ChatMessage[]): string {
  const calls = new Map<string, ToolCall>();
  let photo: { product_id: string } | null = null;
  let pickup: { product_ids: string[]; loja: string; distante: boolean } | null = null;
  for (const message of history) {
    if (message.role === 'assistant') {
      for (const call of message.tool_calls ?? []) calls.set(call.id, call);
    }
    if (message.role !== 'tool' || !message.tool_call_id) continue;
    const call = calls.get(message.tool_call_id);
    if (!call) continue;
    calls.delete(message.tool_call_id);
    const result = object(message.content);
    const args = object(call.function.arguments);
    if (!result || !args) continue;
    const name = call.function.name;
    // Nova consulta comercial pode representar troca de pneu, região ou loja.
    // O histórico completo continua disponível; não fixar a opção anterior.
    if (name === 'buscar_produto' || name === 'buscar_compatibilidade'
      || name === 'registrar_localizacao_lead') {
      photo = null;
      pickup = null;
      continue;
    }
    if (result.erro || result.error) continue;
    if ((name === 'criar_pedido' || name === 'cancelar_pedido') && result.ok === true) {
      photo = null;
      pickup = null;
    } else if (name === 'localizacao_loja') {
      const previousStore = pickup?.loja;
      const productIds = ids(args.product_ids);
      if (productIds.length === 0) continue;
      const store = result.nome_loja ?? result.nome_loja_distante;
      pickup = productIds.length > 0 && typeof store === 'string'
        && (result.encontrado === true || result.motivo === 'retirada_so_longe')
        ? { product_ids: productIds, loja: store, distante: result.motivo === 'retirada_so_longe' } : null;
      if (photo && (!pickup || previousStore !== pickup.loja || !pickup.product_ids.includes(photo.product_id))) photo = null;
    } else if (name === 'pedir_foto' && result.status === 'foto_solicitada') {
      const productId = result.product_id ?? args.product_id;
      if (typeof productId !== 'string' || !productId) continue;
      photo = { product_id: productId };
      if (pickup && !pickup.product_ids.includes(productId)) pickup = null;
    }
  }
  if (!photo && !pickup) return '';
  return `\n\n[CONTINUIDADE DA COMPRA — DADOS DAS FERRAMENTAS]
${JSON.stringify({ foto_solicitada: photo, ultima_consulta_retirada: pickup })}
Dados de consultas anteriores, não são confirmação de retirada pelo cliente, envio da foto, estoque atual ou reserva. A modalidade e a aceitação da distância vêm das falas do cliente no histórico. Aplique PURCHASE CONTINUITY respeitando a mensagem atual.`;
}
