import { describe, expect, it, vi } from 'vitest';
import { classifyMetaAd } from '../../../src/marketing/meta-ad-identity.js';
import { fetchPendingSpend, pendingAdBelongsToReview } from '../../../src/marketing/meta-pending-spend.js';
const config = { adAccountId: 'act_1', accessToken: 'never-log', apiVersion: 'v26.0' };
const ad = classifyMetaAd({ id: '1', campaign_id: '2', creative: { actor_id: '999', instagram_user_id: '17841465774227389' } });
const row = { ad_id: '1', campaign_id: '2', date_start: '2026-10-01', spend: '12.50', account_currency: 'BRL' };
describe('consulta mínima de gasto pendente', () => {
  it('inclui vínculo 2W pelo Facebook ou Instagram, nunca anúncios externos', () => {
    expect(pendingAdBelongsToReview(ad)).toBe(true);
    expect(pendingAdBelongsToReview(classifyMetaAd({ id: '1', campaign_id: '2', creative: { actor_id: '999' } }))).toBe(false);
    expect(pendingAdBelongsToReview(classifyMetaAd({ id: '1', campaign_id: '2' }))).toBe(false);
    const facebook = classifyMetaAd({ id: '1', campaign_id: '2', creative: { actor_id: '999', object_story_spec: { page_id: '1434857906367394' } } });
    expect(pendingAdBelongsToReview(facebook)).toBe(true);
  });
  it('retorno vazio completo comprova zero, mas payload ausente não comprova', async () => {
    expect(await fetchPendingSpend(config, [ad], '2026-10-01', '2026-10-02', async () => Response.json({ data: [] }))).toEqual([]);
    await expect(fetchPendingSpend(config, [ad], '2026-10-01', '2026-10-02', async () => Response.json({}))).rejects.toThrow('api_200');
  });
  it.each([{ ad_id: '999' }, { campaign_id: '999' }, { date_start: '2026-09-30' },
    { spend: '-1' }, { spend: 'NaN' }, { account_currency: 'USD' }])('não aceita métrica inválida %o', async patch => {
    await expect(fetchPendingSpend(config, [ad], '2026-10-01', '2026-10-02', async () => Response.json({ data: [{ ...row, ...patch }] }))).rejects.toThrow();
  });
  it('paginação fora da Meta interrompe a prova e nunca segue o token da URL', async () => {
    const fetcher = vi.fn(async () => Response.json({ data: [row], paging: { next: 'https://evil.test/?access_token=secret' } }));
    await expect(fetchPendingSpend(config, [ad], '2026-10-01', '2026-10-02', fetcher)).rejects.toThrow('pagination_origin');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
