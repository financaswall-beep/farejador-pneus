import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
function front() {
  const context = vm.createContext({ window: { PAINEL_MODULES: {} }, document: { activeElement: { focus: vi.fn() } },
    lucide: { createIcons: vi.fn() }, console, Date });
  vm.runInContext(readFileSync('painel/public/app.marketing.organic.js', 'utf8'), context);
  vm.runInContext(readFileSync('painel/public/app.marketing.organic.summary.js', 'utf8'), context);
  return Object.assign(context.window.PAINEL_MODULES.marketingOrganic(), context.window.PAINEL_MODULES.marketingOrganicSummary(), {
    $nextTick: (fn: () => void) => fn(), marketingIsMock: () => false,
    $refs: { moDialog: { open: false, showModal: vi.fn(), close: vi.fn() }, moClose: { focus: vi.fn() } },
  });
}
const post = (id: string, platform = 'instagram') => ({ id, platform, title: 'Publicação ' + id, caption: 'Pneu NMAX',
  published_at: `2026-09-${id.padStart(2, '0')}T12:00:00Z` });
describe('Publicações — lista e abertura do resumo', () => {
  it('filtra por rede, busca sem acentos, ordena e pagina sem alterar os dados originais', () => {
    const a = front(); a.moData = { rows: Array.from({ length: 12 }, (_, i) => post(String(i + 1), i % 2 ? 'facebook' : 'instagram')) };
    expect(a.moRows()).toHaveLength(8); expect(a.moRows()[0].id).toBe('12');
    a.moChangePage(1); expect(a.moRows()).toHaveLength(4);
    a.moNetwork = 'facebook'; a.moSearch = 'publicacao'; a.moFiltersChanged();
    expect(a.moPage).toBe(1); expect(a.moRows()).toHaveLength(6); expect(a.moData.rows).toHaveLength(12);
    a.moSort = 'oldest'; expect(a.moRows()[0].id).toBe('2');
  });
  it('resposta de filtro antigo não substitui o novo resultado', async () => {
    const a = front(); const pending: Array<(v: unknown) => void> = [];
    a.apiGet = () => new Promise(resolve => pending.push(resolve));
    const first = a.moLoad(); a.moPeriod = '7d'; const second = a.moLoad();
    pending[1]!({ rows: [post('2')] }); await second;
    pending[0]!({ rows: [post('1')] }); await first;
    expect(a.moData.rows[0].id).toBe('2'); expect(a.moLoading).toBe(false);
  });
  it('não reabre modal nem troca seleção após fechar ou escolher outro post', async () => {
    const a = front(); const pending: Array<(v: unknown) => void> = [];
    a.apiGet = () => new Promise(resolve => pending.push(resolve));
    const first = a.moOpen(post('1')); const second = a.moOpen(post('2')); a.moClose();
    pending[1]!({ publication: post('2') }); await second;
    pending[0]!({ publication: post('1') }); await first;
    expect(a.moSelected).toBeNull(); expect(a.moDetail).toBeNull(); expect(a.$refs.moDialog.close).toHaveBeenCalled();
  });
  it('distingue rede indisponível de nenhuma publicação e números ausentes de zero', () => {
    const a = front(); a.moData = { rows: [], sources: [{ platform: 'instagram', status: 'unavailable' }, { platform: 'facebook', status: 'ready' }] };
    a.moNetwork = 'instagram'; expect(a.moListAvailable()).toBe(false); expect(a.moWarnings()).toHaveLength(1);
    a.moNetwork = 'facebook'; expect(a.moListAvailable()).toBe(true); expect(a.moWarnings()).toHaveLength(0);
    expect(a.moSummaryCards().every((k: any) => k.value === null)).toBe(true);
    a.moDetail = { attribution: { status: 'ready', period: {id:'7d'}, private_messages: 0 } };
    expect(a.moSummaryCards()[0].value).toBe(0);
  });
  it('respeita a janela escolhida e volta aos primeiros sete dias ao trocar de post', async () => {
    const a = front(); a.apiGet = vi.fn().mockResolvedValue({publication:post('12')});
    a.moSummaryPeriod = '30d'; await a.moOpen(post('12'), true);
    expect(a.apiGet).toHaveBeenLastCalledWith(expect.stringContaining('?window=30d'));
    await a.moOpen(post('13'));
    expect(a.apiGet).toHaveBeenLastCalledWith(expect.stringContaining('?window=7d'));
  });
});
