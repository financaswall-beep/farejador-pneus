import type { ChatwootConversation } from '../shared/types/chatwoot.js';

export interface MappedConversation {
  environment: string;
  chatwootConversationId: number;
  chatwootAccountId: number;
  chatwootInboxId: number | null;
  channelType: string | null;
  chatwootContactId: number | null;
  currentStatus: string;
  currentAssigneeId: number | null;
  currentTeamId: number | null;
  priority: string | null;
  startedAt: Date;
  lastActivityAt: Date | null;
  resolvedAt: Date | null;
  waitingSince: Date | null;
  additionalAttributes: Record<string, unknown>;
  customAttributes: Record<string, unknown>;
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

function readNestedObject(source: unknown, key: string): Record<string, unknown> | null {
  if (!source || typeof source !== 'object') return null;
  const value = (source as Record<string, unknown>)[key];
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function readNestedNumber(source: unknown, key: string): number | null {
  if (!source || typeof source !== 'object') return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : null;
}

function canonicalChannelType(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const normalized = value.trim().toLowerCase();
  const known: Record<string, string> = {
    'channel::whatsapp': 'whatsapp',
    'channel::facebookpage': 'facebook',
    'channel::instagram': 'instagram',
    'channel::webwidget': 'web',
    whatsapp: 'whatsapp',
    facebook: 'facebook',
    instagram: 'instagram',
    web: 'web',
  };
  return known[normalized] ?? value.trim();
}

export function mapConversation(
  payload: unknown,
  environment: string,
  lastEventAt: Date,
): MappedConversation {
  const p = payload as ChatwootConversation;
  const rawPayload = payload as Record<string, unknown>;

  const additionalAttributes = (p.additional_attributes ?? {}) as Record<string, unknown>;
  const customAttributes = (p.custom_attributes ?? {}) as Record<string, unknown>;
  const meta = readNestedObject(rawPayload, 'meta');
  const metaSender = readNestedObject(meta, 'sender');
  const contactInbox = readNestedObject(rawPayload, 'contact_inbox');
  const account = readNestedObject(rawPayload, 'account');

  const createdAt = parseTimestamp(p.created_at) ?? lastEventAt;
  const updatedAt = parseTimestamp(p.updated_at);
  const timestamp = parseTimestamp(p.timestamp);
  const chatwootContactId =
    p.contact_id
    ?? readNestedNumber(contactInbox, 'contact_id')
    ?? readNestedNumber(metaSender, 'id');

  const resolvedAt =
    p.status === 'resolved' ? (updatedAt ?? timestamp ?? lastEventAt) : null;

  return {
    environment,
    chatwootConversationId: p.id,
    chatwootAccountId: p.account_id ?? readNestedNumber(account, 'id') ?? 0,
    chatwootInboxId: p.inbox_id ?? null,
    channelType: canonicalChannelType(rawPayload.channel)
      ?? canonicalChannelType(additionalAttributes.channel_type),
    chatwootContactId: chatwootContactId ?? null,
    currentStatus: p.status ?? 'open',
    currentAssigneeId: p.assignee_id ?? null,
    currentTeamId: p.team_id ?? null,
    priority: p.priority ?? null,
    startedAt: createdAt,
    lastActivityAt: updatedAt ?? timestamp ?? lastEventAt,
    resolvedAt,
    waitingSince: null,
    additionalAttributes,
    customAttributes,
    lastEventAt,
  };
}
