import { createHash } from 'node:crypto';
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
