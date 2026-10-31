import type { PoolClient } from 'pg';
import { env } from '../shared/config/env.js';
import { logger } from '../shared/logger.js';
import { ChatwootApiError } from '../admin/chatwoot-api.client.js';
import type { OutboundRow } from './outbound-worker.js';
import type { SendMessageResult } from './sender.js';

export const WHOLESALE_CONTACT = {
  name: '2W Pneus — Atacado',
  phone: '5521976674264',
  displayPhone: '(21) 97667-4264',
  url: 'https://wa.me/5521976674264',
} as const;

const CONTACT_LINK = /(?:^|\s)https:\/\/wa\.me\/5521976674264(?=$|\s|[.!;:)](?:\s|$))/;
const TIMEOUT_MS = 10_000;
type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value)
  ? value as JsonObject : {};

function fallback(reason: string): null {
  // Nunca registrar provider_config, tokens, telefone do cliente ou corpo da resposta.
  logger.warn({ reason }, 'agent_v2: wholesale contact uses text fallback');
  return null;
}

async function chatwootGet(url: string): Promise<JsonObject | null> {
  try {
    const response = await fetch(url, {
      headers: { api_access_token: env.CHATWOOT_API_TOKEN! }, redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return object(await response.json());
  } catch { return null; }
}

/** Promove apenas a resposta comercial do bot, já guardada pela outbox.
 * O destinatário vem da conversa autenticada, nunca do modelo ou do contato enviado.
 * Não adiciona outro POST externo quando o resultado do primeiro é desconhecido. */
export async function tryDeliverWholesaleContact(
  client: PoolClient, row: OutboundRow,
): Promise<SendMessageResult | null> {
  if (row.kind !== 'agent_text' || !CONTACT_LINK.test(row.body)) return null;
  if (!env.BOT_OUTBOX) throw new ChatwootApiError('Bot outbox delivery is disabled');
  const result = await client.query<{
    chatwoot_account_id: number; chatwoot_inbox_id: number; channel_type: string | null;
  }>(`SELECT chatwoot_account_id,chatwoot_inbox_id,channel_type FROM core.conversations
    WHERE environment=$1 AND id=$2 AND chatwoot_conversation_id=$3 AND deleted_at IS NULL`,
  [row.environment, row.conversation_id, Number(row.chatwoot_conversation_id)]);
  const local = result.rows[0];
  if (!local) throw Error('wholesale_contact_conversation_unavailable');
  if (!['whatsapp', 'channel::whatsapp'].includes(local.channel_type?.toLowerCase() ?? '')) return null;
  if (!env.CHATWOOT_API_BASE_URL || !env.CHATWOOT_API_TOKEN || !env.CHATWOOT_ACCOUNT_ID) {
    throw new ChatwootApiError('Chatwoot API configuration is missing');
  }
  if (Number(local.chatwoot_account_id) !== Number(env.CHATWOOT_ACCOUNT_ID)) {
    throw Error('wholesale_contact_account_mismatch');
  }
  const base = new URL(env.CHATWOOT_API_BASE_URL);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw Error('wholesale_contact_invalid_chatwoot_origin');
  }
  const accountUrl = `${base.origin}/api/v1/accounts/${env.CHATWOOT_ACCOUNT_ID}`;
  const conversationId = Number(row.chatwoot_conversation_id);
  const conversation = await chatwootGet(`${accountUrl}/conversations/${conversationId}`);
  if (!conversation) return fallback('conversation_lookup_unavailable');
  if (Number(conversation.id) !== conversationId
      || Number(conversation.inbox_id) !== Number(local.chatwoot_inbox_id)
      || (conversation.account_id != null && Number(conversation.account_id) !== Number(env.CHATWOOT_ACCOUNT_ID))) {
    throw Error('wholesale_contact_conversation_mismatch');
  }
  if (conversation.can_reply !== true) {
    throw new ChatwootApiError('WhatsApp contact outside confirmed messaging window', 400);
  }
  const inbox = await chatwootGet(`${accountUrl}/inboxes/${local.chatwoot_inbox_id}`);
  if (!inbox) return fallback('inbox_lookup_unavailable');
  if (Number(inbox.id) !== Number(local.chatwoot_inbox_id)
      || inbox.channel_type !== 'Channel::Whatsapp') throw Error('wholesale_contact_inbox_mismatch');
  if (inbox.provider !== 'whatsapp_cloud') return fallback('unsupported_provider');
  const config = object(inbox.provider_config);
  const token = config.api_key;
  const phoneId = config.phone_number_id;
  if (typeof token !== 'string' || !token.trim() || typeof phoneId !== 'string' || !/^\d{5,30}$/.test(phoneId)) {
    return fallback('provider_config_unavailable');
  }
  let recipient = object(conversation.contact_inbox).source_id;
  // O GET da conversa em produção não inclui contact_inbox. A identidade do
  // canal está em contactable_inboxes, vinculada ao contato E à mesma caixa.
  // Não usar meta.sender.phone_number: pode estar desatualizado ou ser de outro canal.
  if (recipient == null) {
    const sender = object(object(conversation.meta).sender);
    if (!Number.isSafeInteger(sender.id) || Number(sender.id) <= 0) return fallback('contact_identity_unavailable');
    if (sender.account_id != null && Number(sender.account_id) !== Number(env.CHATWOOT_ACCOUNT_ID)) {
      throw Error('wholesale_contact_sender_account_mismatch');
    }
    const associations = await chatwootGet(`${accountUrl}/contacts/${sender.id}/contactable_inboxes`);
    if (!associations) return fallback('contact_inbox_lookup_unavailable');
    const matches = Array.isArray(associations.payload) ? associations.payload.map(object)
      .filter(entry => Number(object(entry.inbox).id) === Number(local.chatwoot_inbox_id)) : [];
    if (matches.length !== 1) return fallback('contact_inbox_not_unique');
    const associatedInbox = object(matches[0]!.inbox);
    if ((associatedInbox.account_id != null && Number(associatedInbox.account_id) !== Number(env.CHATWOOT_ACCOUNT_ID))
        || (associatedInbox.channel_type != null && associatedInbox.channel_type !== 'Channel::Whatsapp')) {
      throw Error('wholesale_contact_association_mismatch');
    }
    recipient = matches[0]!.source_id;
  }
  // Identidades BSUID ou sem telefone conservam o caminho habitual do Chatwoot.
  if (typeof recipient !== 'string' || !/^\d{7,15}$/.test(recipient)) return fallback('recipient_not_phone');

  let response: Response;
  try {
    response = await fetch(`https://graph.facebook.com/v24.0/${phoneId}/messages`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', recipient_type: 'individual', to: recipient,
        type: 'contacts', contacts: [{
          name: { formatted_name: WHOLESALE_CONTACT.name, first_name: '2W Pneus', last_name: 'Atacado' },
          org: { company: '2W Pneus', department: 'Atacado' },
          phones: [{ phone: `+${WHOLESALE_CONTACT.phone}`, wa_id: WHOLESALE_CONTACT.phone, type: 'WORK' }],
        }],
      }),
    });
  } catch {
    throw new ChatwootApiError('WhatsApp contact delivery result unknown', null);
  }
  if (response.status === 429) throw new ChatwootApiError('WhatsApp contact rate limit 429', 429);
  if (!response.ok) {
    if (response.status >= 500) throw new ChatwootApiError('WhatsApp contact delivery result unknown', null);
    // Recusa explícita: não houve aceite do cartão; o link ainda pode ser enviado.
    if (response.status >= 400 && response.status < 500) return fallback('provider_rejected_contact');
    throw new ChatwootApiError('WhatsApp contact delivery result unknown', null);
  }
  let acknowledgment: JsonObject;
  try { acknowledgment = object(await response.json()); }
  catch { throw new ChatwootApiError('WhatsApp contact acknowledgment unknown', null); }
  const nativeId = Array.isArray(acknowledgment.messages) ? object(acknowledgment.messages[0]).id : null;
  if (typeof nativeId !== 'string' || !/^wamid\.[A-Za-z0-9+/=_-]{1,500}$/.test(nativeId)) {
    throw new ChatwootApiError('WhatsApp contact acknowledgment missing message id', null);
  }

  // source_id real faz o Chatwoot reconhecer uma mensagem já enviada pelo canal:
  // registra na conversa e recebe status da Meta, sem enviar o texto outra vez.
  // Se este passo falhar, a outbox exige conferência humana; nunca repete o cartão.
  try {
    const mirrored = await fetch(`${accountUrl}/conversations/${conversationId}/messages`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { api_access_token: env.CHATWOOT_API_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message_type: 'outgoing', private: false, content_type: 'text', source_id: nativeId,
        content: `Contato: ${WHOLESALE_CONTACT.name} · ${WHOLESALE_CONTACT.displayPhone}`,
        ...(row.echo_id ? { echo_id: row.echo_id } : {}),
        content_attributes: {
          farejador_contact: { name: WHOLESALE_CONTACT.name, phone: WHOLESALE_CONTACT.phone },
          ...(row.echo_id ? { farejador_echo_id: row.echo_id } : {}),
        },
      }),
    });
    if (!mirrored.ok) throw Error('mirror_rejected');
    const message = object(await mirrored.json());
    if (!Number.isSafeInteger(message.id) || Number(message.id) <= 0 || message.source_id !== nativeId) {
      throw Error('mirror_acknowledgment_invalid');
    }
    logger.info({ chatwoot_message_id: message.id }, 'agent_v2: native wholesale contact accepted');
    return { chatwootMessageId: Number(message.id) };
  } catch {
    throw new ChatwootApiError('WhatsApp contact accepted; Chatwoot record requires reconciliation', null);
  }
}
