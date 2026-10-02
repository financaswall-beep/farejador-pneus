import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function app() {
  const window = { PAINEL_MODULES: {} as Record<string, () => any> };
  for (const file of ['reviews', 'integrations']) runInNewContext(readFileSync(`painel/public/app.marketing.${file}.js`, 'utf8'), { window });
  return { ...window.PAINEL_MODULES.marketingIntegrations(), marketingIsMock: () => false,
    apiGet: vi.fn(), apiPost: vi.fn(), marketingSetTab: vi.fn(), googleConversionStatus: (status: string) => status };
}

describe('formulário de revisão de Marketing', () => {
  it('remove lista antiga quando uma consulta falha e preserva o resultado da outra', async () => {
    const state = app(); state.googleConversionReviews = [{ id: 'stale' }];
    state.apiGet.mockResolvedValueOnce({ rows: [{ ad_id: '111' }], pending: 1 }).mockRejectedValueOnce(new Error('offline'));
    await state.loadMarketingReviews();
    expect(state.googleConversionReviews).toEqual([]); expect(state.metaIdentityReviews.pending).toBe(1);
    expect(state.marketingReviewError).toContain('não pôde');
  });
  it('encerrar usa a rota de revisão e mantém o envio separado da decisão', async () => {
    const state = app();
    state.marketingReviewChoose('google', { id: 'queue', can_check: false });
    state.marketingReviewReason = 'Conferência concluída na rede';
    state.apiPost.mockResolvedValue({ status: 'closed', queued: false });
    state.apiGet.mockResolvedValue({ rows: [], pending: 0 });
    await state.marketingReviewSubmit();
    expect(state.apiPost).toHaveBeenCalledWith('/admin/api/marketing/google-ads/conversions/queue/review',
      { action: 'close', reason: 'Conferência concluída na rede' });
    expect(state.marketingIntegrationsMessage).toContain('sem novo envio');
    expect(state.marketingReviewSelection).toBeNull();
  });
  it('não inicia decisão sem motivo e não escolhe um evento que saiu da lista', async () => {
    const state = app(); state.marketingReviewChoose('meta', { ad_id: '111' });
    await state.marketingReviewSubmit(); expect(state.apiPost).not.toHaveBeenCalled();
    state.marketingReviewSelection = null; state.apiGet.mockResolvedValue({ rows: [], pending: 0 });
    await state.marketingReviewFromGoogle({ id: 'old-event' }); expect(state.marketingReviewSelection).toBeNull();
  });
});
