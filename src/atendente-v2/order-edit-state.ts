import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';

export interface EditableOrder {
  id:string; order_number:string; total_amount:string; status:string; source:string;
  fulfillment_mode:'pickup'|'delivery'; payment_method:string|null; delivery_address:string|null;
  partner_order_id:string|null; trip_id:string|null; delivery_status:string;
  pickup_arrived_at:Date|null; pickup_installation_started_at:Date|null; is_matrix:boolean; updated_at:Date;
  dispatched_at:Date|null; delivered_at:Date|null; retrieved_at:Date|null; pickup_services:unknown[];
}
export interface EditableItem {
  id:string; product_id:string; product_name:string; product_type:string; quantity:number;
  unit_price:string; discount_amount:string; matriz_unit_cost:string|null;
}
export function amountCents(value:string|number):number {
  const n=Math.round(Number(value)*100);
  if(!Number.isSafeInteger(n)||n<0)throw Error('Valor inválido no pedido. Encaminhe ao humano.');
  return n;
}
export function orderEditFingerprint(order:EditableOrder,items:EditableItem[]):string {
  return createHash('sha256').update(JSON.stringify({order,items})).digest('hex');
}
export async function loadEditableOrder(client:PoolClient,environment:Environment,conversationId:string,orderNumber:string) {
  const order=(await client.query<EditableOrder>(
    `SELECT o.id,o.order_number,o.total_amount,o.status,o.source,o.fulfillment_mode,o.payment_method,o.delivery_address,
       o.partner_order_id,o.trip_id,o.delivery_status,o.pickup_arrived_at,o.pickup_installation_started_at,o.updated_at,
       o.dispatched_at,o.delivered_at,o.retrieved_at,o.pickup_services,
       EXISTS(SELECT 1 FROM core.units u WHERE u.environment=o.environment AND u.id=o.unit_id AND u.slug='main') is_matrix
     FROM commerce.orders o JOIN core.conversations c ON c.environment=o.environment AND c.id=$2 AND c.contact_id=o.contact_id
     WHERE o.environment=$1 AND o.order_number=$3 FOR UPDATE OF o`,[environment,conversationId,orderNumber])).rows[0];
  if(!order)throw Error('Pedido não encontrado para este contato.');
  if(order.status!=='open'||order.partner_order_id||!order.is_matrix||order.source!=='chatwoot_com_bot'
    ||!['pickup','delivery'].includes(order.fulfillment_mode)
    ||order.trip_id||order.pickup_arrived_at||order.pickup_installation_started_at||order.pickup_services.length
    ||order.dispatched_at||order.delivered_at||order.retrieved_at||order.delivery_status!=='pending') {
    throw Error('Pedido pago, em atendimento, em rota ou de parceiro: alteração precisa de atendente humano.');
  }
  const financial=await client.query(`SELECT 1 FROM finance.matriz_ledger_transactions
    WHERE environment=$1 AND (source_id=$2 OR metadata->>'order_id'=$2 OR metadata->>'source_id'=$2) LIMIT 1`,[environment,order.id]);
  if(financial.rows.length)throw Error('Pedido com lançamento financeiro: alteração precisa de atendente humano.');
  const items=(await client.query<EditableItem>(
    `SELECT i.id,i.product_id,i.quantity,i.unit_price,i.discount_amount,i.matriz_unit_cost,p.product_name,p.product_type
     FROM commerce.order_items i JOIN commerce.products p ON p.environment=i.environment AND p.id=i.product_id
     WHERE i.environment=$1 AND i.order_id=$2 ORDER BY i.id FOR UPDATE OF i`,[environment,order.id])).rows;
  if(!items.length||items.some(i=>i.product_type!=='tire'||Number(i.discount_amount)!==0)
    ||new Set(items.map(i=>i.product_id)).size!==items.length) {
    throw Error('Pedido com serviço, desconto ou itens duplicados: alteração precisa de atendente humano.');
  }
  return {order,items};
}

export async function latestOrderEditMessages(client:PoolClient,environment:Environment,conversationId:string) {
  // Uma mensagem por direção permite respostas como "sim" + "pode atualizar".
  // IDs do Chatwoot desempatarão mensagens cujo timestamp tem apenas segundos.
  return (await client.query<{id:string;sender_type:string;sent_at:Date;chatwoot_message_id:string}>(
    `SELECT * FROM (
       SELECT DISTINCT ON (sender_type='contact') id,sender_type,sent_at,chatwoot_message_id
       FROM core.messages
       WHERE environment=$1 AND conversation_id=$2 AND is_private=false AND deleted_at IS NULL
         AND sender_type IN ('contact','user','agent_bot') AND NULLIF(trim(content),'') IS NOT NULL
       ORDER BY (sender_type='contact'),chatwoot_message_id DESC
     ) latest ORDER BY chatwoot_message_id DESC`,[environment,conversationId])).rows;
}
