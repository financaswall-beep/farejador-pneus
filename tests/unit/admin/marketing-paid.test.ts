import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

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
});
