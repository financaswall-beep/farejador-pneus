import { describe, expect, it, vi } from 'vitest';
import { classifyMetaAd, fetchMetaAdIdentities, fetchOwnedMetaInsights, campaignAnchors } from '../../../src/marketing/meta-ad-identity.js';
import { META_BUSINESS_ACCOUNTS as accounts } from '../../../src/shared/meta-business-accounts.js';

const config = { adAccountId: 'act_123', accessToken: 'test-only', apiVersion: 'v26.0' };
const own = { id: '111', campaign_id: '10', creative: { actor_id: accounts.facebook.id } };
describe('escopo Meta por identidade do anúncio', () => {
  it('usa IDs autorizados; nome de campanha e identidade antiga não concedem acesso', () => {
    expect(classifyMetaAd(own).scope).toBe('matrix');
    expect(classifyMetaAd({ ...own, creative: { instagram_user_id: accounts.instagram.id } }).scope).toBe('matrix');
    expect(classifyMetaAd({ ...own, creative: { actor_id: '386020731963435' } }).scope).toBe('external');
    expect(classifyMetaAd({ id: '111', campaign_id: '10' }).scope).toBe('pending');
    expect(classifyMetaAd({ ...own, creative: { actor_id: accounts.facebook.id, instagram_user_id: '999' } }).scope).toBe('pending');
  });
  it('paginação incompleta ou domínio diferente interrompe a coleta inteira', async () => {
    const fetcher = vi.fn(async () => Response.json({ data: [own], paging: { next: 'https://evil.test/next' } }));
    await expect(fetchMetaAdIdentities(config, fetcher)).rejects.toThrow('pagination_origin');
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(fetchMetaAdIdentities(config, async () => Response.json({ error: {} }, { status: 403 }))).rejects.toThrow('api_403');
  });
  it('mudança de veiculação preserva a identidade usada pela aprovação manual', () => {
    const paused = classifyMetaAd({ ...own, effective_status: 'PAUSED' });
    const active = classifyMetaAd({ ...own, effective_status: 'ACTIVE' });
    expect(active.fingerprint).toBe(paused.fingerprint);
    expect(active.effectiveStatus).toBe('ACTIVE');
    expect(classifyMetaAd({ ...own, campaign_id: '20' }).fingerprint).not.toBe(paused.fingerprint);
  });
  it('resposta sem dados não pode concluir a recuperação das métricas como zero', async () => {
    await expect(fetchOwnedMetaInsights(config, [classifyMetaAd(own)], '2026-09-01', '2026-09-30',
      async () => Response.json({}))).rejects.toThrow('meta_invalid_insights_response');
  });
  it('só pede métricas dos anúncios próprios e recusa retorno fora da lista', async () => {
    const identities = [classifyMetaAd(own), classifyMetaAd({ id: '222', campaign_id: '10', creative: { actor_id: '999' } })];
    const fetcher = vi.fn(async (url: URL | RequestInfo) => {
      expect(JSON.parse(new URL(String(url)).searchParams.get('filtering')!)).toEqual([{ field: 'ad.id', operator: 'IN', value: ['111'] }]);
      return Response.json({ data: [{ ad_id: '222', campaign_id: '10' }] });
    });
    await expect(fetchOwnedMetaInsights(config, identities, '2026-09-01', '2026-09-30', fetcher)).rejects.toThrow('identity_mismatch');
    expect(await fetchOwnedMetaInsights(config, [], '2026-09-01', '2026-09-30', fetcher)).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('agrega uma vez por campanha e dia, sem somar alcance de pessoas', () => {
    const rows = campaignAnchors([
      { ad_id: '111', campaign_id: '10', date_start: '2026-09-01', spend: '0.10', impressions: 10, reach: 8 },
      { ad_id: '112', campaign_id: '10', date_start: '2026-09-01', spend: '0.20', impressions: 20, reach: 9 },
      { ad_id: '111', campaign_id: '10', date_start: '2026-09-02', spend: '5', impressions: 1 },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ spend: 0.3, impressions: 30, reach: undefined });
  });
});
