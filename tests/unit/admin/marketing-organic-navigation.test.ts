import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function front() {
  const icons = { createIcons: vi.fn() };
  const window: any = { confirm: vi.fn(() => true), lucide: icons };
  const timers = { set: vi.fn(() => 123), clear: vi.fn() };
  const context = createContext({ window, lucide: icons, crypto: { randomUUID },
    setTimeout: timers.set, clearTimeout: timers.clear, Intl, Date });
  for (const file of ['app.marketing.js', 'app.marketing.organic.js',
    'app.marketing.publisher.view.js', 'app.marketing.publisher.helpers.js', 'app.marketing.publisher.js']) {
    runInContext(readFileSync('painel/public/' + file, 'utf8'), context);
  }
  const modules = window.PAINEL_MODULES;
  const app = Object.assign(modules.marketing(), modules.marketingOrganic(), modules.marketingPublisher(), {
    currentPage: 'marketing', marketingTab: 'comentarios', marketingIsMock: () => false,
    $nextTick: (callback: () => void) => callback(), $refs: {},
    moDestroyChart: vi.fn(), loadMarketingComments: vi.fn(), moLoadControls: vi.fn(),
    destroyMarketingCreativeChart: vi.fn(), closeMarketingCreativeJourneys: vi.fn(), renderMarketingChart: vi.fn(),
    apiGet: vi.fn().mockResolvedValue({ config: { enabled: true, accounts: [] }, media: [], posts: [] }),
    apiPut: vi.fn(), apiPost: vi.fn(),
  });
  return { app, timers, window };
}

describe('Navegação direta do conteúdo orgânico', () => {
  it('entra na criação e carrega somente o motor existente da Central', async () => {
    const { app } = front();
    await app.loadMarketingOrganic();
    expect(app.moActiveTab()).toBe('create');
    expect(app.mpForm.title).toBe('');
    expect(app.apiGet).toHaveBeenCalledExactlyOnceWith('/admin/api/marketing/publisher');
    expect(app.loadMarketingComments).not.toHaveBeenCalled();
    expect(app.apiPut).not.toHaveBeenCalled();
    expect(app.apiPost).not.toHaveBeenCalled();
  });

  it.each(['calendar', 'drafts'])('preserva %s escolhida durante o primeiro carregamento', async tab => {
    const { app } = front();
    let resolve!: (value: unknown) => void;
    app.apiGet.mockReturnValue(new Promise(done => { resolve = done; }));
    const loading = app.loadMarketingOrganic();
    app.moSetTab(tab);
    resolve({ config: { enabled: true }, media: [], posts: [] });
    await loading;
    expect(app.moActiveTab()).toBe(tab);
    expect(app.mpForm).not.toBeNull();
    expect(app.apiGet).toHaveBeenCalledTimes(1);
  });

  it('preserva a edição ao passar por todas as abas e retornar de outra seção do Marketing', async () => {
    const { app, window } = front();
    await app.loadMarketingOrganic();
    Object.assign(app.mpForm, { title: 'Promoção', caption: 'Texto em edição', media_id: 'media-1' });
    app.mpBrief = 'Destacar atendimento'; app.mpDirty = true;
    const form = app.mpForm;
    for (const tab of ['calendar', 'drafts', 'results', 'attendance', 'create']) {
      app.moSetTab(tab);
      expect(app.moActiveTab()).toBe(tab);
      expect(app.mpForm).toBe(form);
      expect(app.mpForm.caption).toBe('Texto em edição');
      expect(app.mpDirty).toBe(true);
    }
    app.marketingSetTab('visao'); app.marketingSetTab('comentarios');
    expect(app.mpForm).toBe(form);
    expect(app.mpBrief).toBe('Destacar atendimento');
    expect(app.apiPut).not.toHaveBeenCalled();
    expect(app.apiPost).not.toHaveBeenCalled();
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it('Resultados e Atendimento usam seus próprios dados e mantêm os atalhos existentes', async () => {
    const { app } = front();
    const results = vi.spyOn(app, 'moLoad').mockResolvedValue(undefined);
    app.moSetTab('results');
    expect(app.moView).toBe('publications');
    expect(results).toHaveBeenCalledOnce();
    app.moGoAttendance();
    expect(app.moActiveTab()).toBe('attendance');
    expect(app.loadMarketingComments).toHaveBeenCalledOnce();
    expect(app.moLoadControls).toHaveBeenCalledOnce();
    expect(app.apiGet).not.toHaveBeenCalled();
  });

  it('o destino antigo Publicados abre Resultados e preserva o rascunho', async () => {
    const { app } = front();
    await app.loadMarketingOrganic();
    const form=app.mpForm;
    app.moSetTab('published');
    expect(app.moActiveTab()).toBe('results');
    expect(app.moTabs().map((t: any)=>t.id)).toEqual(['create','calendar','drafts','results','attendance']);
    expect(app.mpForm).toBe(form);
  });

  it('não retoma a atualização automática se o carregamento termina depois de sair da Central', async () => {
    const { app, timers } = front();
    let resolve!: (value: unknown) => void;
    app.apiGet.mockReturnValue(new Promise(done => { resolve = done; }));
    const loading = app.loadMarketingOrganic();
    app.marketingSetTab('visao');
    resolve({ config: { enabled: true }, media: [], posts: [{ id: 'scheduled', status: 'scheduled' }] });
    await loading;
    expect(timers.set).not.toHaveBeenCalled();
    expect(app.mpTimer).toBeNull();
  });

  it('encerra modais e atualização automática ao sair, sem apagar a edição', async () => {
    const { app, timers } = front();
    app.apiGet.mockResolvedValue({ config: { enabled: true }, media: [], posts: [{ status: 'scheduled' }] });
    await app.loadMarketingOrganic();
    const form = app.mpForm;
    app.mpConnectionsOpen = true; app.mpPreview = {}; app.mpReconciliation = {};
    app.moSetTab('results');
    expect(timers.clear).toHaveBeenLastCalledWith(123);
    expect(app.mpTimer).toBeNull();
    expect(app.mpConnectionsOpen).toBe(false);
    expect(app.mpPreview).toBeNull();
    expect(app.mpReconciliation).toBeNull();
    expect(app.mpForm).toBe(form);
  });

  it('Gerenciar contas também verifica as conexões quando aberto em Resultados', async () => {
    const { app } = front();
    app.moView = 'publications';
    app.apiPost.mockResolvedValue({ connections: [{ platform: 'instagram', publish_allowed: true }] });
    await app.mpCheckConnections();
    expect(app.moActiveTab()).toBe('results');
    expect(app.mpConnectionsOpen).toBe(true);
    expect(app.mpConfig).not.toBeNull();
    expect(app.mpConnections).toHaveLength(1);
    expect(app.apiPost).toHaveBeenCalledExactlyOnceWith('/admin/api/marketing/publisher/connections', {});
    expect(app.apiPut).not.toHaveBeenCalled();
  });
});
