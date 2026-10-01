import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function app() {
  const window = { PAINEL_MODULES: {} as Record<string, () => any> };
  const document = { activeElement: null, querySelector: () => null };
  for (const module of ['paid', 'campaign-detail']) {
    runInNewContext(readFileSync(`painel/public/app.marketing.${module}.js`, 'utf8'), { window, document });
  }
  return { ...window.PAINEL_MODULES.marketingPaid(), ...window.PAINEL_MODULES.marketingCampaignDetail(),
    marketingCampaignDetailId: '10', marketingCampaignDetailRequestSeq: 0, marketingPeriod: '30d',
    marketingIsMock: () => false, $nextTick: vi.fn(), loadMarketingGeography: vi.fn(),
    loadMarketingCreatives: vi.fn(), marketingDateLabel: (date: string) => date };
}

describe('Campanha dentro de Conteúdo pago', () => {
  it('abre sempre a subaba da campanha e preserva os filtros da lista', async () => {
    const state = app();
    state.marketingTab = 'geografia';
    state.marketingCampaignSearch = 'pneus';
    state.apiGet = vi.fn(async () => ({ campaign: { id: '10' }, ads: [] }));
    await state.openMarketingCampaignDetail({ platform_id: '10' });
    expect(state.marketingTab).toBe('campanhas');
    expect(state.mcdTab).toBe('resultado');
    state.closeMarketingCampaignDetail();
    expect(state.marketingTab).toBe('visao');
    expect(state.marketingCampaignSearch).toBe('pneus');
  });
  it('descarta uma resposta antiga ao trocar período ou fechar a campanha', async () => {
    const state = app();
    let finish!: (value: unknown) => void;
    state.apiGet = () => new Promise(resolve => { finish = resolve; });
    const loading = state.loadMarketingCampaignDetail();
    state.marketingPeriod = '7d';
    state.closeMarketingCampaignDetail();
    finish({ campaign: { id: '10' } });
    await loading;
    expect(state.marketingCampaignDetail).toBeNull();
    expect(state.marketingCampaignDetailLoading).toBe(false);
  });
  it('atualiza também a lista e a visão geral ao mudar o período no detalhe', async () => {
    const state = app();
    state.loadMarketing = vi.fn();
    state.apiGet = vi.fn(async () => ({ campaign: { id: '10' }, ads: [] }));
    state.marketingPeriod = '7d';
    await state.mcdPeriodChanged();
    expect(state.loadMarketing).toHaveBeenCalledOnce();
    expect(state.apiGet).toHaveBeenCalledWith('/admin/api/marketing/campaigns/10?period=7d');
  });
  it('não mostra falha de consulta como zero de envios ou custo completo', () => {
    const state = app();
    state.marketingCampaignDetail = { quality: { attributed_sales: 2, complete_cost_orders: null },
      conversions: { available: false, sent: null } };
    expect(state.mcdCapiCount('sent')).toBe('—');
    expect(state.mcdCapiStatus()).toBe('Indisponível');
    expect(state.mcdCostsLabel()).toBe('Indisponível');
    expect(state.mcdCostsComplete()).toBe(false);
    state.marketingCampaignDetail.conversions = { available: true, enabled: true, sent: 0 };
    expect(state.mcdCapiCount('sent')).toBe('0');
  });
  it('encaminha os anúncios selecionados da campanha à comparação no mesmo período', () => {
    const state = app();
    state.marketingCreativesData = { creatives: [{ id: 'outra-campanha', scope: 'matrix' }] };
    state.marketingCampaignDetail = { campaign: { id: '10', name: '2W', scope: 'matrix', currency: 'BRL' },
      period: { since: '2026-09-01', until: '2026-09-30' }, ads: [
        { id: 'a', conversations_started: 3, cost_per_started: 5 },
        { id: 'b', conversations_started: 4, cost_per_started: 6 },
      ] };
    state.paidCompare = vi.fn();
    state.mcdSelected = ['b'];
    state.mcdCompare();
    expect(state.paidCompare).toHaveBeenCalledWith(['b'], expect.objectContaining({
      creatives: expect.arrayContaining([expect.objectContaining({ id: 'b', conversations: 4, cost_per_conversation: 6 })]),
      period: { since: '2026-09-01', until: '2026-09-30' },
    }));
    expect(state.marketingCreativesData.creatives[0].id).toBe('outra-campanha');
    expect(state.loadMarketingCreatives).not.toHaveBeenCalled();
  });
  it('filtra região por campanha e não reutiliza dados de outro período', () => {
    const state = app();
    state.mgData = { period: { id: '30d' }, records: [{ id: '10' }, { id: '20' }] };
    expect(state.mcdRegions()).toEqual([{ id: '10' }]);
    state.marketingPeriod = '7d';
    expect(state.mcdRegions()).toEqual([]);
    state.mcdSetTab('regioes');
    expect(state.loadMarketingGeography).toHaveBeenCalledOnce();
  });
  it('usa a mídia elegível no gráfico financeiro, não o gasto externo', () => {
    const state = app();
    state.marketingCampaignDetail = { summary: { investment: 400, financial_investment: 100 }, financial: {} };
    expect(state.marketingCampaignDetailFinancialRows().find((r: any) => r.id === 'media').value).toBe(-100);
  });
});
