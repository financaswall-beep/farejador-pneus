import type { ChatwootMessage } from '../shared/types/chatwoot.js';

export interface MappedMessage {
  environment: string;
  chatwootMessageId: number;
  chatwootAccountId: number;
  chatwootInboxId: number | null;
  chatwootConversationId: number;
  senderType: string;
  senderId: number | null;
  messageType: number;
  content: string | null;
  contentType: string | null;
  contentAttributes: Record<string, unknown>;
  nativeMessageId: string | null;
  isPrivate: boolean;
  status: string | null;
  externalSourceIds: Record<string, unknown> | null;
  echoId: string | null;
  sentAt: Date;
  lastEventAt: Date;
}

function parseTimestamp(ts: unknown): Date | null {
  if (ts == null) return null;
  if (typeof ts === 'number') return new Date(ts * 1000);
  if (typeof ts === 'string') {
    const d = new Date(ts);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function normalizeMessageType(mt: unknown): number {
  if (typeof mt === 'number') return mt;
  const map: Record<string, number> = {
    incoming: 0,
    outgoing: 1,
    activity: 2,
    template: 3,
  };
  if (typeof mt === 'string') {
    const mapped = map[mt as keyof typeof map];
    if (mapped !== undefined) return mapped;
  }
  return 0;
}

function normalizeSenderType(st: unknown): string {
  if (typeof st !== 'string') return 'system';
  const lower = st.toLowerCase();
  const valid = ['contact', 'user', 'agent_bot', 'system'];
  return valid.includes(lower) ? lower : 'system';
}

function readNestedNumber(source: unknown, key: string): number | null {
  if (!source || typeof source !== 'object') return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : null;
}

function readNestedObject(source: unknown, key: string): Record<string, unknown> | null {
  if (!source || typeof source !== 'object') return null;
  const value = (source as Record<string, unknown>)[key];
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function readNestedString(source: unknown, key: string): string | null {
  if (!source || typeof source !== 'object') return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

export function mapMessage(
  payload: unknown,
  environment: string,
  lastEventAt: Date,
): MappedMessage {
  const p = payload as ChatwootMessage;
  const rawPayload = payload as Record<string, unknown>;
  const nestedConversation = rawPayload.conversation;
  const nestedSender = rawPayload.sender;
  const nestedConversationMeta = readNestedObject(nestedConversation, 'meta');
  const nestedConversationMetaSender = readNestedObject(nestedConversationMeta, 'sender');
  const nestedAccount = rawPayload.account;
  const nestedInbox = rawPayload.inbox;

  const senderType = normalizeSenderType(
    p.sender_type
      ?? readNestedString(nestedSender, 'type')
      ?? readNestedString(nestedConversationMetaSender, 'type'),
  );

  let senderId: number | null = p.sender_id ?? null;
  if (
    senderId == null &&
    nestedSender &&
    typeof nestedSender === 'object' &&
    Object.keys(nestedSender).length > 0
  ) {
    senderId = readNestedNumber(nestedSender, 'id');
  }

  const messageType = normalizeMessageType(p.message_type);
  const sentAt = parseTimestamp(p.created_at) ?? lastEventAt;
  const chatwootConversationId = p.conversation_id ?? readNestedNumber(nestedConversation, 'id') ?? 0;

  return {
    environment,
    chatwootMessageId: p.id,
    chatwootAccountId: p.account_id ?? readNestedNumber(nestedAccount, 'id') ?? 0,
    chatwootInboxId: p.inbox_id ?? readNestedNumber(nestedInbox, 'id'),
    chatwootConversationId,
    senderType,
    senderId,
    messageType,
    content: p.content ?? null,
    contentType: p.content_type ?? null,
    contentAttributes: (p.content_attributes ?? {}) as Record<string, unknown>,
    nativeMessageId: p.source_id ?? null,
    isPrivate: p.private ?? false,
    status: p.status ?? null,
    externalSourceIds: p.external_source_ids
      ? (p.external_source_ids as Record<string, unknown>)
      : null,
    echoId: p.echo_id ?? null,
    sentAt,
    lastEventAt,
  };
}
