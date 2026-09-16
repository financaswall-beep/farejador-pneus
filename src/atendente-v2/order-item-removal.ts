import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Environment } from '../shared/types/chatwoot.js';
import { releaseRemovedMatrizItems } from './matriz-stock-reservation.js';

const removalInput = z.object({
  order_number: z.string().trim().min(1).max(40).transform(value => value.toUpperCase()),
  remover_itens: z.array(z.string().uuid()).min(1).max(30),
  motivo: z.string().trim().max(300).optional(),
}).strict();

interface Order {
  id: string; order_number: string; total_amount: string; status: string;
  partner_order_id: string | null; fulfillment_mode: string; delivery_status: string;
  trip_id: string | null; source: string; is_matrix: boolean;
  pickup_arrived_at: Date | null; pickup_installation_started_at: Date | null;
}
interface Item {
  id: string; product_id: string; quantity: number; unit_price: string;
  discount_amount: string; line_total: string; product_name: string;
  product_type: string; matriz_unit_cost: string | null;
}
function cents(value: string): number {
  const result = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('order_amount_invalid');
  return result;
}
function response(order: Order, items: Item[], unchanged: boolean) {
  return {
    ok: true, order_number: order.order_number, total: order.total_amount,
    sem_alteracao: unchanged, modalidade: order.fulfillment_mode,
    itens: items.map(item => ({ product_id: item.product_id, produto: item.product_name,
      quantidade: item.quantity, preco_unitario: item.unit_price })),
    mensagem: unchanged ? 'Os itens solicitados já foram removidos.'
      : 'Pedido atualizado e reserva dos itens removidos liberada.',
  };
}

/** Ação determinística: remove produtos inteiros de uma reserva da Matriz.
 * Não recebe preço/total do modelo; não altera venda realizada ou pedido de parceiro. */
export async function removeOpenOrderItems(
  client: PoolClient, environment: Environment, conversationId: string, args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const parsed = removalInput.safeParse(args);
  if (!parsed.success) return { erro: 'Informe pedido e product_ids dos itens a remover, sem misturar outras alterações.' };
  const input = parsed.data;
  const requested = [...new Set(input.remover_itens)];
  await client.query('BEGIN');
  try {
    const found = await client.query<Order>(
      `SELECT o.id,o.order_number,o.total_amount,o.status,o.partner_order_id,o.fulfillment_mode,
              o.delivery_status,o.trip_id,o.source,o.pickup_arrived_at,o.pickup_installation_started_at,
              EXISTS (SELECT 1 FROM core.units u WHERE u.environment=o.environment
                AND u.id=o.unit_id AND u.slug='main') is_matrix
         FROM commerce.orders o
         JOIN core.conversations c ON c.environment=o.environment AND c.id=$2 AND c.contact_id=o.contact_id
        WHERE o.environment=$1 AND o.order_number=$3 FOR UPDATE OF o`,
      [environment, conversationId, input.order_number],
    );
    const order = found.rows[0];
    if (!order) throw new Error('Pedido não encontrado para este contato.');
    if (order.status !== 'open' || order.partner_order_id || !order.is_matrix
      || order.source !== 'chatwoot_com_bot' || !['pickup','delivery'].includes(order.fulfillment_mode)
      || order.trip_id || order.pickup_arrived_at || order.pickup_installation_started_at
      || (order.fulfillment_mode === 'delivery' && order.delivery_status !== 'pending')) {
      throw new Error('Este pedido já avançou no atendimento ou pertence a um parceiro. A alteração precisa de atendente humano.');
    }
    const financial = await client.query(
      `SELECT 1 FROM finance.matriz_ledger_transactions
        WHERE environment=$1 AND (source_id=$2 OR metadata->>'order_id'=$2) LIMIT 1`,
      [environment, order.id],
    );
    if (financial.rows.length) throw new Error('Pedido com lançamento financeiro: alteração precisa de atendente humano.');
    const items = (await client.query<Item>(
      `SELECT i.id,i.product_id,i.quantity,i.unit_price,i.discount_amount,i.matriz_unit_cost,
              (i.quantity*i.unit_price-i.discount_amount)::text line_total,p.product_name,p.product_type
         FROM commerce.order_items i JOIN commerce.products p ON p.environment=i.environment AND p.id=i.product_id
        WHERE i.environment=$1 AND i.order_id=$2 ORDER BY i.id FOR UPDATE OF i`,
      [environment, order.id],
    )).rows;
    const missing = requested.filter(id => !items.some(item => item.product_id === id));
    if (missing.length) {
      const prior = await client.query<{ removed: string[] }>(
        `SELECT payload_after->'removed_product_ids' removed FROM audit.events
          WHERE environment=$1 AND entity_id=$2 AND event_type='bot_order_items_removed'`,
        [environment, order.id],
      );
      const alreadyRemoved = new Set(prior.rows.flatMap(row => row.removed ?? []));
      if (missing.some(id => !alreadyRemoved.has(id))) throw new Error('Item não encontrado neste pedido. Consulte o pedido antes de editar.');
    }
    const removed = items.filter(item => requested.includes(item.product_id));
    if (!removed.length) {
      await client.query('COMMIT');
      return response(order, items, true);
    }
    const remaining = items.filter(item => !requested.includes(item.product_id));
    if (!remaining.length) throw new Error('Para retirar todos os itens, use cancelar_pedido após confirmar o cancelamento.');
    if (items.some(item => item.product_type !== 'tire')) throw new Error('Pedido com serviços: alteração precisa de atendente humano.');
    const oldTotal = cents(order.total_amount);
    const itemTotal = items.reduce((sum, item) => sum + cents(item.line_total), 0);
    if (itemTotal > oldTotal) throw new Error('Pedido com ajuste de preço: alteração precisa de atendente humano.');
    const newTotal = oldTotal - removed.reduce((sum, item) => sum + cents(item.line_total), 0);
    // Mantém frete já cotado e os preços/custos congelados dos pneus restantes.
    await releaseRemovedMatrizItems(client, environment, order.id,
      removed.map(item => ({ productId: item.product_id, quantity: item.quantity })));
    await client.query('DELETE FROM commerce.order_items WHERE environment=$1 AND order_id=$2 AND id=ANY($3::uuid[])',
      [environment, order.id, removed.map(item => item.id)]);
    await client.query('UPDATE commerce.orders SET total_amount=$3,updated_at=now() WHERE environment=$1 AND id=$2',
      [environment, order.id, (newTotal / 100).toFixed(2)]);
    await client.query(
      `INSERT INTO audit.events (environment,domain,entity_table,entity_id,event_type,actor_label,payload_before,payload_after)
       VALUES ($1,'orders','commerce.orders',$2,'bot_order_items_removed','agent_v2_bot',$3::jsonb,$4::jsonb)`,
      [environment, order.id, JSON.stringify({ total: order.total_amount, items }),
        JSON.stringify({ total: (newTotal / 100).toFixed(2), items: remaining,
          removed_product_ids: removed.map(item => item.product_id), reason: input.motivo ?? 'cliente_solicitou',
          conversation_id: conversationId })],
    );
    await client.query('COMMIT');
    return response({ ...order, total_amount: (newTotal / 100).toFixed(2) }, remaining, false);
  } catch (error) {
    await client.query('ROLLBACK');
    return { erro: error instanceof Error ? error.message : 'Não foi possível alterar o pedido.',
      sugestao: 'Não confirme alteração que falhou. Encaminhe ao humano se o pedido não puder ser editado.' };
  }
}
