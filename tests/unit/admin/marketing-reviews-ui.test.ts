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
  it('início financeiro usa sua própria rota e mostra a pendência sem confundir com classificação', async () => {
    const state=app();state.marketingReviewChoose('finance',{ad_account_id:'act_123',finance_since:'2026-06-01'});
    state.marketingFinanceStart='2026-10-01';state.marketingReviewReason='Início oficial da operação';
    state.apiPost.mockResolvedValue({since:'2026-10-01'});state.apiGet.mockResolvedValue({rows:[],accounts:[],pending:0});
    await state.marketingReviewSubmit();
    expect(state.apiPost).toHaveBeenCalledWith('/admin/api/marketing/meta/ad-accounts/act_123/finance-start',
      {since:'2026-10-01',reason:'Início oficial da operação'});
    expect(state.marketingIdentityFinancialLabel({scope:'pending',financial_pending_reason:null})).toContain('Sem pendência');
    expect(state.marketingIdentityFinancialLabel({scope:'matrix',financial_pending_reason:'verification_missing'})).toContain('incompleta');
    expect(readFileSync('painel/public/index.html','utf8')).toContain("marketingReviewChoose('finance',account)");
  });
});
