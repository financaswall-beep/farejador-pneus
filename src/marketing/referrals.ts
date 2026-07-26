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
}

function text(value: unknown): string | null {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function referralFrom(attributes: Record<string, unknown>): Record<string, unknown> | null {
  const referral = attributes.referral;
  return referral && typeof referral === 'object'
    ? referral as Record<string, unknown>
    : null;
}

export function extractAdReferral(attributes: Record<string, unknown>) {
  const referral = referralFrom(attributes);
  if (!referral) return null;
  const ctwaClid = text(referral.ctwa_clid ?? referral.ctwaClid);
  if (!ctwaClid) return null;
  return {
    ctwaClid,
    sourceId: text(referral.source_id ?? referral.sourceId),
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
       ctwa_clid,source_id,source_url,source_type,headline,captured_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$4)
     ON CONFLICT (environment,ctwa_clid) DO NOTHING`,
    [
      input.environment,
      input.conversationId,
      input.messageId,
      input.messageSentAt,
      referral.ctwaClid,
      referral.sourceId,
      referral.sourceUrl,
      referral.sourceType,
      referral.headline,
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
