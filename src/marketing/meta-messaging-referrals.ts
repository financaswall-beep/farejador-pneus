import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';
import { logger } from '../shared/logger.js';
import type {
  DirectMetaChannel,
  ObservedMetaMessagingReferral,
} from './meta-messaging-referral-extractor.js';

export { extractMetaMessagingReferrals } from './meta-messaging-referral-extractor.js';
export type {
  DirectMetaChannel,
  ObservedMetaMessagingReferral,
} from './meta-messaging-referral-extractor.js';

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

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO marketing.ad_referrals (
       environment,conversation_id,source_message_id,source_message_sent_at,
       channel,referral_key,ctwa_clid,source_id,source_type,headline,captured_at,
       user_scoped_id,business_account_id,native_message_id,referral_payload
     ) VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,$8,$9,$4,$10,$11,$12,
       jsonb_build_object('provider_event_key',$13::text,'ref',$14::text))
     ON CONFLICT DO NOTHING
     RETURNING id`,
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
  if (inserted.rows.length === 0) {
    const existing = await client.query<{ id: string }>(
      `SELECT id
         FROM marketing.ad_referrals
        WHERE environment=$1 AND channel=$2 AND referral_key=$3
          AND source_message_id=$4 AND conversation_id=$5
        LIMIT 1`,
      [
        environment,
        referral.channel,
        `${referral.channel}:${referral.provider_event_key}`,
        match.messageId,
        match.conversationId,
      ],
    );
    if (existing.rows.length === 0) return false;
  }
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
  await client.query(
    `UPDATE marketing.meta_messaging_referrals
        SET status='unmatched',updated_at=now()
      WHERE environment=$1 AND status='pending'
        AND created_at < now()-interval '7 days'`,
    [environment],
  );
  const result = await client.query<PendingReferralRow>(
    `SELECT id,provider_event_key,channel,provider_message_id,user_scoped_id,
            business_account_id,ad_id,referral_ref,source_type,headline,occurred_at
      FROM marketing.meta_messaging_referrals
      WHERE environment=$1 AND status='pending'
        AND provider_message_id IS NOT NULL
        AND ($2::text IS NULL OR provider_message_id=$2)
        AND ($3::bigint IS NULL OR raw_event_id=$3)
      ORDER BY occurred_at,id
      LIMIT 100`,
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
