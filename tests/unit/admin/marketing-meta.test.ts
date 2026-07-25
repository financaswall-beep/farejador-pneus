import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearMetaMarketingCache,
  getMetaMarketingSnapshot,
  marketingDateWindow,
} from '../../../src/admin/painel/marketing-meta.js';

const config = {
  accessToken: 'segredo-apenas-no-servidor',
  adAccountId: 'act_123',
  apiVersion: 'v21.0',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Marketing Meta read-only', () => {
  beforeEach(() => clearMetaMarketingCache());

  it('separa período atual/anterior e soma somente ações aceitas como conversa', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({
      data: [
        {
          campaign_id: 'camp-1',
          date_start: '2026-07-19',
          spend: '10',
          actions: [
            { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '4' },
            { action_type: 'purchase', value: '99' },
          ],
        },
        {
          campaign_id: 'camp-2',
          date_start: '2026-07-20',
          spend: '20',
          actions: [{ action_type: 'lead', value: '2' }],
        },
        {
          campaign_id: 'camp-old',
          date_start: '2026-07-12',
          spend: '5',
          actions: [{ action_type: 'onsite_conversion.lead_grouped', value: '1' }],
        },
      ],
    }));

    const snapshot = await getMetaMarketingSnapshot(config, '7d', {
      now: new Date('2026-07-25T12:00:00.000Z'),
      fetcher: fetcher as typeof fetch,
      cacheMs: 0,
    });

    expect(marketingDateWindow('7d', new Date('2026-07-25T12:00:00.000Z'))).toEqual({
      days: 7,
      since: '2026-07-19',
      until: '2026-07-25',
      previousSince: '2026-07-12',
      previousUntil: '2026-07-18',
    });
    expect(snapshot.current).toMatchObject({
      spend: 30,
      conversations: 6,
      campaigns: 2,
      cost_per_conversation: 5,
    });
    expect(snapshot.previous).toMatchObject({
      spend: 5,
      conversations: 1,
      campaigns: 1,
    });
    expect(fetcher).toHaveBeenCalledOnce();
    const requested = fetcher.mock.calls[0]?.[0] as URL;
    expect(requested.hostname).toBe('graph.facebook.com');
    expect(requested.searchParams.get('level')).toBe('campaign');
    expect(requested.searchParams.get('time_increment')).toBe('1');
  });

  it('recusa paginação que tente retirar o token do domínio oficial', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({
      data: [],
      paging: { next: 'https://example.com/roubar-token' },
    }));

    await expect(getMetaMarketingSnapshot(config, '30d', {
      now: new Date('2026-07-25T12:00:00.000Z'),
      fetcher: fetcher as typeof fetch,
      cacheMs: 0,
    })).rejects.toThrow('meta_invalid_pagination_origin');
  });
});
