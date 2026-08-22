import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  extractMetaMessagingReferrals,
  reconcilePendingMetaReferrals,
} from '../../../src/marketing/meta-messaging-referrals.js';

describe('referrals diretos da Meta', () => {
  it('extrai referral de anúncio do Messenger e ignora mensagem orgânica', () => {
    const result = extractMetaMessagingReferrals({
      object: 'page',
      entry: [{
        id: 'page-123',
        messaging: [
          {
            sender: { id: 'psid-456' },
            timestamp: 1785600000000,
            message: {
              mid: 'mid.messenger.1',
              text: 'Olá',
              referral: {
                ad_id: 'ad-789', source: 'ADS', type: 'OPEN_THREAD', ref: 'campanha-a',
                ads_context_data: { ad_title: 'Pneu aro 15' },
              },
            },
          },
          { sender: { id: 'psid-organico' }, message: { mid: 'mid.organic', text: 'Oi' } },
        ],
      }],
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      channel: 'messenger',
      providerMessageId: 'mid.messenger.1',
      userScopedId: 'psid-456',
      businessAccountId: 'page-123',
      adId: 'ad-789',
      headline: 'Pneu aro 15',
    });
    expect(result[0]?.providerEventKey).toMatch(/^[a-f0-9]{64}$/);
  });

  it('extrai messaging_referral do Instagram', () => {
    const result = extractMetaMessagingReferrals({
      object: 'instagram',
      entry: [{
        id: 'ig-business-1',
        messaging: [{
          sender: { id: 'igsid-2' },
          timestamp: 1785600000000,
          message: { mid: 'mid.instagram.1' },
          referral: { ad_id: 'ad-ig-3', source: 'ADS', type: 'OPEN_THREAD' },
        }],
      }],
    });

    expect(result[0]).toMatchObject({
      channel: 'instagram',
      providerMessageId: 'mid.instagram.1',
      userScopedId: 'igsid-2',
      businessAccountId: 'ig-business-1',
      adId: 'ad-ig-3',
    });
  });

  it('só casa quando existe exatamente uma mensagem com o mesmo ID nativo', async () => {
    const pending = {
      id: 'pending-1', provider_event_key: 'event-1', channel: 'messenger',
      provider_message_id: 'mid.same', user_scoped_id: 'psid-1',
      business_account_id: 'page-1', ad_id: 'ad-1', referral_ref: null,
      source_type: 'ADS', headline: null, occurred_at: new Date('2026-08-01T12:00:00Z'),
    };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM marketing.meta_messaging_referrals')) {
        return { rows: [pending], rowCount: 1 };
      }
      if (sql.includes('FROM core.messages')) {
        return {
          rows: [{ id: 'msg-1', conversation_id: 'conv-1', channel_type: 'facebook' }],
          rowCount: 1,
        };
      }
      if (sql.includes('INSERT INTO marketing.ad_referrals')) {
        return { rows: [{ id: 'ref-1' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const matched = await reconcilePendingMetaReferrals(
      { query } as unknown as PoolClient,
      'test',
    );

    expect(matched).toBe(1);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO marketing.ad_referrals')))
      .toBe(true);
    const insertSql = String(query.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO marketing.ad_referrals'))?.[0]);
    expect(insertSql).toContain('$13::text');
    expect(insertSql).toContain('$14::text');
    const pendingSql = String(query.mock.calls.find(([sql]) =>
      String(sql).includes('FROM marketing.meta_messaging_referrals'))?.[0]);
    expect(pendingSql).toContain('provider_message_id IS NOT NULL');
    expect(pendingSql).toContain('ORDER BY occurred_at,id');
    expect(query.mock.calls.some(([sql]) => String(sql).includes("status='unmatched'")))
      .toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("status='matched'")))
      .toBe(true);
  });

  it('não marca staging como casado quando o referral conflita com outra cadeia', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM marketing.meta_messaging_referrals')) {
        return { rows: [{
          id: 'pending-2', provider_event_key: 'event-2', channel: 'messenger',
          provider_message_id: 'mid.conflict', user_scoped_id: 'psid-2',
          business_account_id: 'page-2', ad_id: 'ad-2', referral_ref: null,
          source_type: 'ADS', headline: null, occurred_at: new Date('2026-08-21T12:00:00Z'),
        }], rowCount: 1 };
      }
      if (sql.includes('FROM core.messages')) {
        return { rows: [{ id: 'msg-2', conversation_id: 'conv-2', channel_type: 'facebook' }] };
      }
      return { rows: [], rowCount: 0 };
    });

    await expect(reconcilePendingMetaReferrals(
      { query } as unknown as PoolClient,
      'test',
    )).resolves.toBe(0);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("status='matched'")))
      .toBe(false);
  });
});
