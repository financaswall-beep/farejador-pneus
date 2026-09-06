import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function setup() {
  const sandbox = {
    window: { PAINEL_MODULES: {} as Record<string, () => object> },
    document: { hidden: false }, location: { pathname: '/admin/painel' },
    lucide: { createIcons: vi.fn() },
  };
  for (const name of ['app.bot.js', 'app.core.js']) {
    runInNewContext(readFileSync(`painel/public/${name}`, 'utf8'), sandbox);
  }
  const ui: Record<string, any> = {};
  for (const factory of Object.values(sandbox.window.PAINEL_MODULES)) {
    Object.defineProperties(ui, Object.getOwnPropertyDescriptors(factory()));
  }
  Object.assign(ui, {
    adminAuthenticated: true, currentPage: 'bot', botPeriodo: 'today', botLoading: false,
    ensureCredentials: vi.fn(), hasPanelModule: () => true, isMatrixPanel: () => true,
    $nextTick: (f: () => void) => f(), renderBotMapa: vi.fn(),
    loadSino: vi.fn(), loadBotCampainha: vi.fn(), apiGet: vi.fn(),
  });
  return { ui, sandbox };
}

function data(n: number) {
  return { funil: [{ etapa: 'recebeu_cotacao', n }], mapa: [
    { municipio: 'Maricá', chamou: n, pediu: 0, efetivou: 0, faltou: 0 },
  ] };
}

describe('indicadores do bot ao vivo sem piscar', () => {
  it('recarrega a visão na aba Bot pela rotina de 15s', async () => {
    const { ui } = setup();
    ui.loadBotVisao = vi.fn().mockResolvedValue(undefined);
    await ui.liveRefresh();
    expect(ui.loadBotVisao).toHaveBeenCalledWith({ silent: true });
    expect(ui.liveRefreshing).toBe(false);
  });

  it('mantém os dados durante a consulta e atualiza a seleção do mapa', async () => {
    const { ui } = setup();
    const before = data(1);
    ui.botVisao = before; ui.botMapaSel = before.mapa[0];
    let resolve!: (v: unknown) => void;
    ui.apiGet.mockReturnValue(new Promise(r => { resolve = r; }));
    const pending = ui.loadBotVisao({ silent: true });
    expect(ui.botVisao).toBe(before); expect(ui.botLoading).toBe(false);
    resolve(data(2)); await pending;
    expect(ui.botVisao.funil[0].n).toBe(2);
    expect(ui.botMapaSel).toMatchObject({ municipio: 'Maricá', chamou: 2 });
    expect(ui.renderBotMapa).toHaveBeenCalledOnce();
    expect(ui.apiGet).toHaveBeenCalledTimes(1); // Resiliência já vem da campainha.
  });

  it('falha de rede não apaga os dados nem redesenha o mapa', async () => {
    const { ui } = setup();
    const before = data(1); ui.botVisao = before;
    ui.apiGet.mockRejectedValue(new Error('offline'));
    await ui.loadBotVisao({ silent: true });
    expect(ui.botVisao).toBe(before); expect(ui.botLoading).toBe(false);
    expect(ui.renderBotMapa).not.toHaveBeenCalled();
  });

  it('dados iguais preservam a instância e não redesenham o mapa', async () => {
    const { ui } = setup();
    const before = data(1); ui.botVisao = before;
    ui.apiGet.mockResolvedValue(data(1));
    await ui.loadBotVisao({ silent: true });
    expect(ui.botVisao).toBe(before); expect(ui.renderBotMapa).not.toHaveBeenCalled();
  });

  it('resposta antiga não substitui o filtro novo', async () => {
    const { ui } = setup();
    const resolvers: Array<(v: unknown) => void> = [];
    ui.apiGet.mockImplementation((url: string) => url.includes('/visao?')
      ? new Promise(r => resolvers.push(r)) : Promise.resolve({}));
    const old = ui.loadBotVisao();
    ui.botPeriodo = '7d';
    const current = ui.loadBotVisao();
    resolvers[1]!(data(7)); await current;
    resolvers[0]!(data(1)); await old;
    expect(ui.botVisao.funil[0].n).toBe(7); expect(ui.botLoading).toBe(false);
    expect(ui.renderBotMapa).toHaveBeenCalledOnce();
  });

  it('não concorre com carga manual e respeita aba oculta e autenticação', async () => {
    const { ui, sandbox } = setup();
    ui.botLoading = true;
    await ui.loadBotVisao({ silent: true });
    expect(ui.apiGet).not.toHaveBeenCalled();
    ui.loadBotVisao = vi.fn(); sandbox.document.hidden = true;
    await ui.liveRefresh(); expect(ui.loadBotVisao).not.toHaveBeenCalled();
    sandbox.document.hidden = false; ui.adminAuthenticated = false;
    await ui.liveRefresh(); expect(ui.loadBotVisao).not.toHaveBeenCalled();
  });
});
