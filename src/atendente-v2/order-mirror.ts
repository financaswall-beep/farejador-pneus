import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';
import { env } from '../shared/config/env.js';
import { applyMatrizRetailCostSnapshot } from './wholesale-stock-read.js';
import { reserveMatrizGalpaoStock } from './matriz-stock-reservation.js';
import { postMatrizRetailSaleFacts } from '../admin/painel/matriz-ledger-retail-sales.js';

/**
 * Grava o ESPELHO em commerce.orders + order_items e devolve {id, order_number}.
 * Extraído do criar_pedido (Tijolo 3.2) pra os DOIS caminhos — matriz e parceiro —
 * usarem a MESMA peça, sem duplicar o INSERT. Comportamento idêntico ao de antes;
 * o caminho parceiro vai passar unit_id da loja (e, após a migration 0081, o link).
 */
export async function insertCommerceOrderMirror(
  client: PoolClient,
  environment: Environment,
  input: {
    contactId: string;
    conversationId: string;
    totalAmount: string;
    fulfillmentMode: string;
    paymentMethod: string | null;
    deliveryAddress: string | null;
    geoResolutionId: string | null;
    customerName: string | null;
    customerPhone: string;
    unitId: string | null;
    partnerOrderId?: string | null;
    idempotencyKey?: string | null;
    items: { product_id: string; quantity: number; unit_price: string }[];
  },
): Promise<{ id: string; order_number: string }> {
  // idempotency_key dedup via índice parcial orders_idempotency_key_uniq — os DOIS
  // caminhos (parceiro e matriz) passam chave estável; em colisão o ON CONFLICT DO
  // NOTHING devolve o existente abaixo. Chave NULA (defensivo) nunca conflita → INSERT normal.
  const ins = await client.query<{ id: string; order_number: string }>(
    `INSERT INTO commerce.orders (
       environment, contact_id, source_conversation_id, total_amount, status,
       fulfillment_mode, payment_method, delivery_address, geo_resolution_id, source, customer_name, unit_id,
       partner_order_id, idempotency_key, customer_phone
     ) VALUES ($1, $2, $3, $4, 'open', $5, $6, $7, $8, 'chatwoot_com_bot', $9, $10, $11, $12, $13)
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING id, order_number`,
    [
      environment,
      input.contactId,
      input.conversationId,
      input.totalAmount,
      input.fulfillmentMode,
      input.paymentMethod,
      input.deliveryAddress,
      input.geoResolutionId,
      input.customerName,
      input.unitId,
      input.partnerOrderId ?? null,
      input.idempotencyKey ?? null,
      input.customerPhone,
    ],
  );

  if (ins.rows[0]) {
    const order = ins.rows[0];
    for (const item of input.items) {
      await client.query(
        `INSERT INTO commerce.order_items (environment, order_id, product_id, quantity, unit_price)
         VALUES ($1, $2, $3, $4, $5)`,
        [environment, order.id, item.product_id, item.quantity, item.unit_price],
      );
    }
    // Matriz vende no varejo (!partnerOrderId) → abate o GALPÃO na MESMA transação. Parceiro
    // NUNCA entra aqui (tem partner_order_id + reserva o próprio partner_stock_levels). Só na
    // inserção REAL — o caminho de colisão de idempotência (retry) abaixo NÃO baixa de novo.
    if (!input.partnerOrderId) {
      await reserveMatrizGalpaoStock(
        client,
        environment,
        order.id,
        input.items.map((i) => ({ productId: i.product_id, quantity: i.quantity })),
        env.WHOLESALE_MATRIZ_DECREMENT,
      );
      // Fatia 2 (0117): CONGELA o custo médio do galpão nos itens da venda da matriz —
      // o lucro desta venda não muda quando o custo médio mudar depois. Mesma transação
      // (rollback desfaz venda + retrato juntos). Item sem custo no galpão fica NULL.
      await applyMatrizRetailCostSnapshot(
        client,
        environment,
        order.id,
        input.items.map((i) => ({ productId: i.product_id, quantity: i.quantity })),
        env.WHOLESALE_MATRIZ_RETAIL_COST,
      );
      await postMatrizRetailSaleFacts(client, environment, order.id);
    }
    return order;
  }

  // Sem linha = colisão de idempotência (retry/dupla-chamada do MESMO pedido): devolve o
  // existente sem reinserir itens. Vale pros dois caminhos (parceiro e matriz têm chave).
  if (input.idempotencyKey) {
    const ex = await client.query<{ id: string; order_number: string }>(
      `SELECT id, order_number FROM commerce.orders
       WHERE environment = $1 AND idempotency_key = $2 LIMIT 1`,
      [environment, input.idempotencyKey],
    );
    if (ex.rows[0]) return ex.rows[0];
  }
  throw new Error('Falha ao criar pedido');
}
