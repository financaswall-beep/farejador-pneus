import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';
import { logger } from '../shared/logger.js';

interface ReferralCaptureInput {
  environment: 'prod' | 'test';
  conversationId: string;
  messageId: string;
  messageSentAt: Date;
  senderType: string;
  isPrivate: boolean;
  contentAttributes: Record<string, unknown>;
  nativeMessageId?: string | null;
}

export type MarketingMessagingChannel = 'whatsapp' | 'messenger' | 'instagram';

function text(value: unknown): string | null {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function referralFrom(attributes: Record<string, unknown>): Record<string, unknown> | null {
  const direct = object(attributes.referral);
  if (direct) return direct;
  for (const wrapper of ['whatsapp', 'instagram', 'facebook', 'messenger']) {
    const nested = object(object(attributes[wrapper])?.referral);
    if (nested) return nested;
  }
  return null;
}

export function extractAdReferral(attributes: Record<string, unknown>) {
  const referral = referralFrom(attributes);
  if (!referral) return null;
  const ctwaClid = text(referral.ctwa_clid ?? referral.ctwaClid);
  if (!ctwaClid) return null;
  return {
    channel: 'whatsapp' as const,
    referralKey: `whatsapp:${ctwaClid}`,
    ctwaClid,
    sourceId: text(referral.source_id ?? referral.sourceId ?? referral.ad_id ?? referral.adId),
    sourceUrl: text(referral.source_url ?? referral.sourceUrl),
    sourceType: text(referral.source_type ?? referral.sourceType),
    headline: text(referral.headline),
  };
}

export async function captureAdReferral(
  client: PoolClient,
  input: ReferralCaptureInput,
): Promise<boolean> {
  if (input.senderType !== 'contact' || input.isPrivate) return false;
  const referral = extractAdReferral(input.contentAttributes);
  if (!referral) return false;
  const result = await client.query(
    `INSERT INTO marketing.ad_referrals (
       environment,conversation_id,source_message_id,source_message_sent_at,
       channel,referral_key,ctwa_clid,source_id,source_url,source_type,headline,
       native_message_id,referral_payload,captured_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$4)
     ON CONFLICT DO NOTHING`,
    [
      input.environment,
      input.conversationId,
      input.messageId,
      input.messageSentAt,
      referral.channel,
      referral.referralKey,
      referral.ctwaClid,
      referral.sourceId,
      referral.sourceUrl,
      referral.sourceType,
      referral.headline,
      input.nativeMessageId ?? null,
      JSON.stringify(input.contentAttributes),
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function captureAdReferralAfterMessageUpsert(
  client: PoolClient,
  environment: Environment,
  message: {
    sentAt: Date;
    senderType: string;
    isPrivate: boolean;
    contentAttributes: Record<string, unknown>;
    nativeMessageId?: string | null;
    chatwootMessageId: number;
  },
  upserted: { conversationId: string; messageId: string },
): Promise<void> {
  if (!extractAdReferral(message.contentAttributes)) return;
  await client.query('SAVEPOINT marketing_referral_capture');
  try {
    await captureAdReferral(client, {
      environment,
      conversationId: upserted.conversationId,
      messageId: upserted.messageId,
      messageSentAt: message.sentAt,
      senderType: message.senderType,
      isPrivate: message.isPrivate,
      contentAttributes: message.contentAttributes,
      nativeMessageId: message.nativeMessageId,
    });
    await client.query('RELEASE SAVEPOINT marketing_referral_capture');
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT marketing_referral_capture');
    logger.warn(
      { err: error, chatwoot_message_id: message.chatwootMessageId },
      'normalization: marketing referral capture deferred',
    );
  }
}
