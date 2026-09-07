import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';

interface ConversationMessage {
  sender_type: string;
}

function normalized(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

export function deliveryAddressHasNumber(address: string): boolean {
  const value = normalized(address);
  return /\d/.test(value) || /\bs\s*\/\s*n\b/.test(value) || /\bsem numero\b/.test(value);
}

async function conversationHasImmediateCustomerReply(client: PoolClient, conversationId: string): Promise<boolean> {
  const result = await client.query<ConversationMessage>(
    `SELECT sender_type
       FROM core.messages
      WHERE conversation_id=$1 AND is_private=false AND deleted_at IS NULL
        AND NULLIF(trim(content),'') IS NOT NULL
        AND sender_type IN ('contact','agent_bot','user')
      ORDER BY sent_at DESC,id DESC LIMIT 2`,
    [conversationId],
  );
  return result.rows[0]?.sender_type === 'contact'
    && ['agent_bot','user'].includes(result.rows[1]?.sender_type ?? '');
}

async function previousAddress(
  client: PoolClient,
  environment: Environment,
  contactId: string,
): Promise<string | null> {
  const result = await client.query<{ delivery_address: string }>(
    `SELECT delivery_address
       FROM commerce.orders
      WHERE environment=$1 AND contact_id=$2 AND fulfillment_mode='delivery'
        AND (delivery_status='delivered' OR status='delivered')
        AND NULLIF(trim(delivery_address),'') IS NOT NULL
      ORDER BY COALESCE(delivered_at,closed_at,created_at) DESC,id DESC LIMIT 1`,
    [environment,contactId],
  );
  return result.rows[0]?.delivery_address?.trim() || null;
}

export type DeliveryAddressResolution =
  | { ok: true; address: string; source: 'current_conversation' | 'previous_delivery' }
  | { ok: false; code: 'endereco_entrega_obrigatorio' | 'numero_endereco_obrigatorio' | 'confirmacao_endereco_anterior_obrigatoria' | 'endereco_anterior_indisponivel' };

export async function resolveDeliveryAddress(
  client: PoolClient,
  environment: Environment,
  conversationId: string,
  contactId: string,
  input: { address?: unknown; usePrevious?: boolean },
): Promise<DeliveryAddressResolution> {
  const informed = typeof input.address === 'string' ? input.address.trim() : '';
  if (informed) {
    return deliveryAddressHasNumber(informed)
      ? { ok:true,address:informed,source:'current_conversation' }
      : { ok:false,code:'numero_endereco_obrigatorio' };
  }
  if (!input.usePrevious) return { ok:false,code:'endereco_entrega_obrigatorio' };
  // O GPT interpreta semanticamente a confirmação e envia usePrevious=true.
  // O backend não tenta reinterpretar a fala com regex: só garante a sequência
  // bot -> cliente, evitando reutilizar endereço sem uma resposta nova do cliente.
  if (!await conversationHasImmediateCustomerReply(client,conversationId)) {
    return { ok:false,code:'confirmacao_endereco_anterior_obrigatoria' };
  }
  const address = await previousAddress(client,environment,contactId);
  if (!address) return { ok:false,code:'endereco_anterior_indisponivel' };
  if (!deliveryAddressHasNumber(address)) return { ok:false,code:'numero_endereco_obrigatorio' };
  return { ok:true,address,source:'previous_delivery' };
}
