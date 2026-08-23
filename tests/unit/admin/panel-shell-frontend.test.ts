import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const readPanel = (file: string) => readFileSync(
  resolve(process.cwd(), 'painel', 'public', file), 'utf8',
);

describe('casco derivado do painel único', () => {
  it('deriva o menu dos módulos do servidor sem filtrar ou alterar o catálogo', () => {
    const nav = readPanel('app.nav.js');
    const api = readPanel('app.api.js');
    const state = readPanel('app.js');

    expect(nav).toContain('get liveMenu()');
    expect(nav).toContain('enabled.has(item.requires)');
    expect(api).toContain('payload.modules');
    expect(api).not.toMatch(/this\.liveMenu\s*=/);
    expect(state).not.toMatch(/liveMenu:\s*\[/);
  });

  it('exibe somente páginas cujo módulo e escopo foram autorizados', () => {
    const sandbox: Record<string, any> = { window: {} };
    runInNewContext(readPanel('app.nav.js'), sandbox);
    const app: any = {
      panelScope: 'matrix', panelModules: ['resumo', 'estoque'], menuBadges: { resumo: '2' },
    };
    Object.defineProperties(
      app, Object.getOwnPropertyDescriptors(sandbox.window.PAINEL_MODULES.nav()),
    );

    expect(app.liveMenu.map((item: { id: string }) => item.id)).toEqual(['resumo', 'estoque']);
    expect(app.liveMenu[0].badge).toBe('2');
    app.panelModules = ['financeiro'];
    expect(app.liveMenu.map((item: { id: string }) => item.id)).toEqual(['financeiro']);
  });

  it('mantém o badge fora do getter e registra o ciclo de cada página uma vez', () => {
    const nav = readPanel('app.nav.js');
    const bot = readPanel('app.bot.js');
    const core = readPanel('app.core.js');

    expect(nav).toContain('window.PAINEL_PAGES = {');
    expect(bot).toContain('this.menuBadges.bot =');
    expect(bot).not.toMatch(/item\.badge\s*=/);
    expect(core).toContain("this.$watch('currentPage', (page) => { this.activatePanelPage(page); });");
    expect(core).not.toMatch(/if \(page === '(compras|estoque|logistica|vendas|clientes)'\)/);
  });

  it('bloqueia o boot administrativo fora do escopo da Matriz', () => {
    const core = readPanel('app.core.js');
    expect(core).toContain("if (!this.isMatrixPanel()) {");
    expect(core).toMatch(/if \(!this\.isMatrixPanel\(\)\) \{[\s\S]*activatePanelPage[\s\S]*return;/);
    expect(core).toMatch(/hasPanelModule\('bot'\).*loadBotCampainha/);
    expect(core).toMatch(/hasPanelModule\('rede'\).*loadComissoes/);
  });
});
