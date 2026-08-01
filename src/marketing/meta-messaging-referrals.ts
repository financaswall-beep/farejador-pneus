import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';
import { logger } from '../shared/logger.js';
import type { MarketingMessagingChannel } from './referrals.js';

export type DirectMetaChannel = Exclude<MarketingMessagingChannel, 'whatsapp'>;

export interface ObservedMetaMessagingReferral {
  providerEventKey: string;
  channel: DirectMetaChannel;
  providerMessageId: string | null;
  userScopedId: string;
  businessAccountId: string;
  adId: string;
  referralRef: string | null;
  sourceType: string | null;
  headline: string | null;
  occurredAt: Date;
  referralPayload: Record<string, unknown>;
}

interface PendingReferralRow {
  id: string;
  provider_event_key: string;
  channel: DirectMetaChannel;
  provider_message_id: string | null;
  user_scoped_id: string;
  business_account_id: string;
  ad_id: string;
  referral_ref: string | null;
  source_type: string | null;
  headline: string | null;
  occurred_at: Date;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | null {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function eventDate(value: unknown, fallback: Date): Date {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  const millis = numeric > 10_000_000_000 ? numeric : numeric * 1000;
  const parsed = new Date(millis);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function eventKey(parts: Array<string | null>): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function extractMetaMessagingReferrals(
  payload: unknown,
  receivedAt = new Date(),
): ObservedMetaMessagingReferral[] {
  const root = object(payload);
  if (!root) return [];
  const channel: DirectMetaChannel | null = root.object === 'instagram'
    ? 'instagram'
    : root.object === 'page'
      ? 'messenger'
      : null;
  if (!channel) return [];

  const referrals: ObservedMetaMessagingReferral[] = [];
  for (const rawEntry of array(root.entry)) {
    const entry = object(rawEntry);
    const businessAccountId = text(entry?.id);
    if (!entry || !businessAccountId) continue;
    for (const rawMessaging of array(entry.messaging)) {
      const messaging = object(rawMessaging);
      if (!messaging) continue;
      const message = object(messaging.message);
      const postback = object(messaging.postback);
      const referral = object(message?.referral)
        ?? object(messaging.referral)
        ?? object(postback?.referral);
      if (!referral) continue;
      const adId = text(referral.ad_id ?? referral.adId ?? referral.source_id);
      const sender = object(messaging.sender);
      const userScopedId = text(sender?.id);
      if (!adId || !userScopedId) continue;
      const providerMessageId = text(message?.mid ?? messaging.message_id);
      const referralRef = text(referral.ref);
      const sourceType = text(referral.source ?? referral.source_type);
      const context = object(referral.ads_context_data);
      const headline = text(context?.ad_title ?? referral.headline);
      const occurredAt = eventDate(messaging.timestamp, receivedAt);
      referrals.push({
        providerEventKey: eventKey([
          channel,
          businessAccountId,
          userScopedId,
          providerMessageId,
          adId,
          occurredAt.toISOString(),
          referralRef,
        ]),
        channel,
        providerMessageId,
        userScopedId,
        businessAccountId,
        adId,
        referralRef,
        sourceType,
        headline,
        occurredAt,
        referralPayload: referral,
      });
    }
  }
  return referrals;
}

export async function persistObservedMetaReferral(
  client: PoolClient,
  environment: Environment,
  rawEventId: number,
  referral: ObservedMetaMessagingReferral,
): Promise<void> {
  await client.query(
    `INSERT INTO marketing.meta_messaging_referrals (
       environment,raw_event_id,provider_event_key,channel,provider_message_id,
       user_scoped_id,business_account_id,ad_id,referral_ref,source_type,headline,
       occurred_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (environment,provider_event_key) DO NOTHING`,
    [
      environment,
      rawEventId,
      referral.providerEventKey,
      referral.channel,
      referral.providerMessageId,
      referral.userScopedId,
      referral.businessAccountId,
      referral.adId,
      referral.referralRef,
      referral.sourceType,
      referral.headline,
      referral.occurredAt,
    ],
  );
}

function channelCompatible(channel: DirectMetaChannel, coreChannel: string | null): boolean {
  if (coreChannel == null) return true;
  if (channel === 'instagram') return coreChannel === 'instagram';
  return coreChannel === 'facebook' || coreChannel === 'messenger';
}

async function matchPendingReferral(
  client: PoolClient,
  environment: Environment,
  referral: PendingReferralRow,
  knownMessage?: { messageId: string; conversationId: string; channelType: string | null },
): Promise<boolean> {
  if (!referral.provider_message_id) return false;
  let match = knownMessage;
  if (!match) {
    const messages = await client.query<{
      id: string;
      conversation_id: string;
      channel_type: string | null;
    }>(
      `SELECT m.id,m.conversation_id,c.channel_type
         FROM core.messages m
         JOIN core.conversations c
           ON c.environment=m.environment AND c.id=m.conversation_id
        WHERE m.environment=$1 AND m.native_message_id=$2
          AND m.sender_type='contact' AND m.is_private=false
        ORDER BY m.sent_at
        LIMIT 2`,
      [environment, referral.provider_message_id],
    );
    if (messages.rows.length !== 1) return false;
    const row = messages.rows[0]!;
    match = {
      messageId: row.id,
      conversationId: row.conversation_id,
      channelType: row.channel_type,
    };
  }
  if (!channelCompatible(referral.channel, match.channelType)) return false;

  await client.query(
    `INSERT INTO marketing.ad_referrals (
       environment,conversation_id,source_message_id,source_message_sent_at,
       channel,referral_key,ctwa_clid,source_id,source_type,headline,captured_at,
       user_scoped_id,business_account_id,native_message_id,referral_payload
     ) VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,$8,$9,$4,$10,$11,$12,
       jsonb_build_object('provider_event_key',$13,'ref',$14))
     ON CONFLICT DO NOTHING`,
    [
      environment,
      match.conversationId,
      match.messageId,
      referral.occurred_at,
      referral.channel,
      `${referral.channel}:${referral.provider_event_key}`,
      referral.ad_id,
      referral.source_type,
      referral.headline,
      referral.user_scoped_id,
      referral.business_account_id,
      referral.provider_message_id,
      referral.provider_event_key,
      referral.referral_ref,
    ],
  );
  await client.query(
    `UPDATE marketing.meta_messaging_referrals
        SET status='matched',matched_message_id=$3,matched_conversation_id=$4,
            matched_at=now(),updated_at=now()
      WHERE environment=$1 AND id=$2 AND status='pending'`,
    [environment, referral.id, match.messageId, match.conversationId],
  );
  return true;
}

export async function reconcilePendingMetaReferrals(
  client: PoolClient,
  environment: Environment,
  options: {
    providerMessageId?: string;
    knownMessage?: { messageId: string; conversationId: string; channelType: string | null };
    rawEventId?: number;
  } = {},
): Promise<number> {
  const result = await client.query<PendingReferralRow>(
    `SELECT id,provider_event_key,channel,provider_message_id,user_scoped_id,
            business_account_id,ad_id,referral_ref,source_type,headline,occurred_at
       FROM marketing.meta_messaging_referrals
      WHERE environment=$1 AND status='pending'
        AND ($2::text IS NULL OR provider_message_id=$2)
        AND ($3::bigint IS NULL OR raw_event_id=$3)
      ORDER BY occurred_at,id`,
    [environment, options.providerMessageId ?? null, options.rawEventId ?? null],
  );
  let matched = 0;
  for (const referral of result.rows) {
    if (await matchPendingReferral(client, environment, referral, options.knownMessage)) {
      matched += 1;
    }
  }
  return matched;
}

export async function reconcilePendingMetaReferralsForMessage(
  client: PoolClient,
  environment: Environment,
  message: {
    nativeMessageId?: string | null;
    senderType: string;
    isPrivate: boolean;
    chatwootMessageId: number;
  },
  upserted: { messageId: string; conversationId: string },
): Promise<void> {
  if (!message.nativeMessageId || message.senderType !== 'contact' || message.isPrivate) return;
  await client.query('SAVEPOINT marketing_meta_referral_match');
  try {
    const channel = await client.query<{ channel_type: string | null }>(
      `SELECT channel_type FROM core.conversations
        WHERE environment=$1 AND id=$2`,
      [environment, upserted.conversationId],
    );
    await reconcilePendingMetaReferrals(client, environment, {
      providerMessageId: message.nativeMessageId,
      knownMessage: {
        messageId: upserted.messageId,
        conversationId: upserted.conversationId,
        channelType: channel.rows[0]?.channel_type ?? null,
      },
    });
    await client.query('RELEASE SAVEPOINT marketing_meta_referral_match');
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT marketing_meta_referral_match');
    logger.warn(
      { err: error, chatwoot_message_id: message.chatwootMessageId },
      'normalization: Meta messaging referral match deferred',
    );
  }
}
