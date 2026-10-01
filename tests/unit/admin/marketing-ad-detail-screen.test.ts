import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function front() {
  const configs: any[] = [];
  const trigger = { focus: vi.fn() };
  const context = vm.createContext({ window: { PAINEL_MODULES: {} }, URL, URLSearchParams,
    document: { activeElement: trigger, querySelector: () => null, getElementById: () => ({ focus() {} }) },
    lucide: { createIcons() {} }, Chart: function (_canvas: unknown, config: any) {
      configs.push(config); this.destroy = () => {};
    },
  });
  for (const name of ['creatives', 'campaign-detail', 'ad-detail', 'creatives.chart']) {
    vm.runInContext(readFileSync(`painel/public/app.marketing.${name}.js`, 'utf8'), context);
  }
  const app = Object.assign({}, ...Object.values(context.window.PAINEL_MODULES).map((factory: any) => factory()), {
    $nextTick: (fn: () => void) => fn(), currentPage: 'marketing', marketingTab: 'criativos',
    marketingIsMock: () => false, marketingPeriod: '30d', marketingDateLabel: (date: string) => date,
    loadMarketing: vi.fn(), loadMarketingCampaignDetail: vi.fn(), paidCompare: vi.fn(),
  });
  return { app, configs, trigger };
}
const payload = (name = 'Pneu') => ({ available: true, period: { since: '2026-09-01', until: '2026-09-03' },
  ad: { id: '1', name, currency: 'BRL', investment: 20, conversations: 4, cost_per_conversation: 5,
    series: [{ date: '2026-09-01', spend: 10, conversations: 2 }, { date: '2026-09-03', spend: 10, conversations: 0 }] },
  campaign: { id: '10', name: 'Campanha', cost_per_conversation: 20 }, financial: {}, peers: [],
});

describe('Navegação e apresentação do anúncio', () => {
  it('abre pela galeria e retorna preservando filtros e seleção', async () => {
    const { app, trigger } = front();
    app.apiGet = vi.fn(async () => payload());
    app.marketingCreativeSearch = 'moto'; app.marketingCreativeCompareIds = ['1','2'];
    await app.madOpen({ id: '1' });
    expect(app.apiGet).toHaveBeenCalledWith('/admin/api/marketing/creatives/1/detail?period=30d');
    expect(app.madData.ad.name).toBe('Pneu');
    app.madClose();
    expect(app.madId).toBeNull(); expect(app.marketingTab).toBe('criativos');
    expect(app.marketingCreativeSearch).toBe('moto'); expect([...app.marketingCreativeCompareIds]).toEqual(['1','2']);
    expect(trigger.focus).toHaveBeenCalled();
  });
  it('descarta respostas antigas e não reabre anúncio fechado durante a consulta', async () => {
    const { app } = front(); const pending: Array<(value: unknown) => void> = [];
    app.apiGet = () => new Promise(resolve => pending.push(resolve));
    const old = app.madOpen({ id: '1' });
    app.marketingPeriod = '7d'; const fresh = app.madLoad();
    pending[1]!(payload('Novo')); await fresh;
    pending[0]!(payload('Antigo')); await old;
    expect(app.madData.ad.name).toBe('Novo');
    const next = app.madLoad(); app.madClose(); pending[2]!(payload()); await next;
    expect(app.madData).toBeNull(); expect(app.madLoading).toBe(false);
  });
  it('um erro apaga dados antigos e permite tentar novamente', async () => {
    const { app } = front(); app.madId = '1'; app.madData = payload();
    app.apiGet = vi.fn().mockRejectedValueOnce(Error('offline')).mockResolvedValue(payload('Recuperado'));
    await app.madLoad(); expect(app.madData).toBeNull(); expect(app.madError).toContain('Não foi possível');
    await app.madLoad(); expect(app.madError).toBe(''); expect(app.madData.ad.name).toBe('Recuperado');
  });
  it('usa a média da campanha no gráfico e deixa lacunas em dias sem conversas', () => {
    const { app, configs } = front(); app.madId = '1'; app.madData = payload();
    app.renderMarketingCreativeChart();
    expect([...configs[0].data.datasets[0].data]).toEqual([5, null, null]);
    expect([...configs[0].data.datasets[1].data]).toEqual([20,20,20]);
    expect(configs[0].data.datasets[1].label).toBe('Média da campanha');
    expect(app.madComparison()).toContain('75% abaixo');
    app.madSetTab('envios'); expect(configs).toHaveLength(1);
  });
  it('zero, ausência e indisponibilidade de conversão são diferentes', () => {
    const { app } = front();
    expect(app.madMoney(null)).toBe('—'); expect(app.madCapiCount('sent')).toBe('—');
    app.madData = { conversions: { available: true, enabled: false, sent: 0, events: [
      { id: 'a', status: 'pending' }, { id: 'b', status: 'processing' }, { id: 'c', status: 'dead_letter' },
    ] } };
    expect(app.madCapiCount('sent')).toBe('0'); expect(app.madCapiLabel()).toBe('Desativado');
    app.madEventFilter = 'pending'; expect(app.madEvents()).toHaveLength(2);
    app.madEventFilter = 'failed'; expect(app.madEvents()).toHaveLength(1);
  });
  it('a comparação permanece no período e campanha do detalhe', () => {
    const { app } = front(); app.madData = { ...payload(), peers: [{ id: '1' }, { id: '2' }, { id: '3' }] };
    app.madCompare();
    expect(app.paidCompare).toHaveBeenCalledWith(['1','2'], { creatives: app.madData.peers, period: app.madData.period });
  });
  it('consulta pedidos e conversas por termo e só forma link com identificadores válidos', () => {
    const { app } = front(); app.madTab = 'vendas'; app.madSearch = '1099';
    app.madData = { chatwoot_base: 'https://chat.example.test', orders: { rows: [
      { id: '1', order_number: '#1099', account_id: 1, conversation_id: 88, channel: 'whatsapp' },
      { id: '2', order_number: '#2000', account_id: 1, conversation_id: 99, channel: 'instagram' },
    ] } };
    expect(app.madOrders()).toHaveLength(1);
    expect(app.madChatUrl(app.madOrders()[0])).toBe('https://chat.example.test/app/accounts/1/conversations/88');
    expect(app.madChatUrl({ account_id: '../2', conversation_id: 88 })).toBeNull();
  });
});
