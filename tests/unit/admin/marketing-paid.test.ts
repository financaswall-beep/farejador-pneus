import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function app() {
  const window = { PAINEL_MODULES: {} as Record<string, () => any> };
  runInNewContext(readFileSync('painel/public/app.marketing.paid.js', 'utf8'), { window, document: { activeElement: null } });
  return { ...window.PAINEL_MODULES.marketingPaid(), marketingCampaignPage: 1,
    formatCurrency: (value: number) => `R$ ${value}`, marketingCampaignFiltered: () => [] };
}
describe('Conteúdo pago', () => {
  it('mantém indisponível diferente de zero e não inventa retorno de conversões', () => {
    const state = app();
    expect(state.paidKpis().every((row: any) => row.value === '—')).toBe(true);
    expect(state.paidCapiCount('sent')).toBe('—');
    state.marketingVisao = { metrics: { attributed_sales: 0 }, pipeline: { available: true, capi: { sent: 0 } } };
    expect(state.paidKpis().find((row: any) => row.id === 'sales').value).toBe('0');
    expect(state.paidCapiCount('sent')).toBe('0');
  });
  it('abre pela Matriz, exclui outros canais e mantém histórico externo acessível', () => {
    const state = app();
    state.marketingCampaignFiltered = () => [
      { id: 'own', channel: 'meta', scope: 'matrix', investment: 50 },
      { id: 'external', channel: 'meta', scope: 'external', investment: 400 },
      { id: 'future', channel: 'tiktok', scope: 'matrix', investment: 999 },
    ];
    expect(state.paidRows().map((r: any) => r.id)).toEqual(['own']);
    state.paidScope = 'all';
    expect(state.paidRows().map((r: any) => r.id)).toEqual(['external','own']);
    state.paidOrder('investment');
    expect(state.paidRows().map((r: any) => r.id)).toEqual(['own','external']);
  });
  it('compara no máximo três anúncios e nunca inclui externos', () => {
    const state = app();
    state.marketingCreativesData = { creatives: [{ id: '1', scope: 'matrix' }, { id: '2', scope: 'external' }] };
    expect(state.paidCompareOptions().map((r: any) => r.id)).toEqual(['1']);
    ['1','3','4','5'].forEach(id => state.paidToggleCompare(id));
    expect(state.paidCompareIds).toEqual(['1','3','4']);
    state.paidToggleCompare('3'); state.paidToggleCompare('5');
    expect(state.paidCompareIds).toEqual(['1','4','5']);
  });
  it('abre a comparação com a seleção dos cards sem substituir por outros anúncios', async () => {
    const state = app();
    state.$nextTick = () => {};
    state.loadMarketingCreatives = vi.fn();
    state.marketingCreativesData = { creatives: [
      { id: '1', scope: 'matrix' }, { id: '2', scope: 'matrix' },
      { id: '3', scope: 'matrix' }, { id: 'outside', scope: 'external' },
    ] };
    await state.paidCompare(['2', '3', 'outside', 'missing']);
    expect(state.paidCompareOpen).toBe(true);
    expect(state.paidCompareIds).toEqual(['2', '3']);
    expect(state.loadMarketingCreatives).not.toHaveBeenCalled();
  });
});
