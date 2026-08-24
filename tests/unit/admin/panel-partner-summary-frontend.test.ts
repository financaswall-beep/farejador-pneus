import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('resumo do parceiro no painel único', () => {
  it('usa a flag por unidade e mantém o legado quando ela está desligada', () => {
    const route = source('src/admin/login.route.ts');
    const login = source('painel/public/login.js');

    expect(route).toContain('modern_panel_enabled: workplace.modernPanelEnabled');
    expect(login).toContain('payload.modern_panel_enabled === true');
    expect(login).toContain("? '/admin/painel'");
    expect(login).toContain('`/parceiro/${encodeURIComponent(payload.slug)}/`');
  });

  it('nunca envia ps_ para /admin/api e aceita recursos apenas sob a unidade autenticada', () => {
    const partnerApi = source('painel/public/app.partner-api.js');
    const adminApi = source('painel/public/app.api.js');

    expect(partnerApi).toContain('`/parceiro/${encodeURIComponent(this.panelPartnerSlug)}/api/${resource}`');
    expect(partnerApi).toContain('Authorization: `Bearer ${this.panelPartnerToken}`');
    expect(partnerApi).toContain("resource.includes('..')");
    expect(adminApi).not.toContain('this.panelPartnerToken');
    expect(partnerApi).not.toMatch(/fetch\(['"`]\/admin\/api/);
  });

  it('valida /me com ps_ antes de habilitar o escopo e os módulos da unidade', async () => {
    const token = `ps_${'a'.repeat(64)}`;
    const values = new Map([['farejador_partner_token_loja-a', token]]);
    const storage = {
      getItem: (key: string) => values.get(key) || null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({
        slug: 'loja-a', role: 'owner', unit_name: 'Loja A', display_name: 'Ana',
        modern_panel_enabled: true,
        permissions: { resumo: true, financeiro: false },
      }),
    }));
    const sandbox: Record<string, any> = {
      window: {}, sessionStorage: storage, localStorage: storage,
      fetch: fetchMock, location: { replace: vi.fn() },
    };
    runInNewContext(source('painel/public/app.partner-api.js'), sandbox);
    const app: any = {
      adminAuthenticated: false, panelScope: 'matrix', panelPartnerSlug: '',
      panelPartnerToken: '', panelWorkplace: null, panelModules: [], adminUser: { role: 'owner' },
      operatorLabel: '', currentPage: 'resumo', panelPageEnabled: () => true,
      firstPanelPage: () => 'resumo',
    };
    Object.defineProperties(
      app, Object.getOwnPropertyDescriptors(sandbox.window.PAINEL_MODULES.partnerApi()),
    );

    await app.ensurePartnerPanelCredentials({
      id: 'partner:loja-a', slug: 'loja-a', name: 'Loja A', modern_panel_enabled: true,
    });

    expect(fetchMock).toHaveBeenCalledWith('/parceiro/loja-a/api/me', expect.objectContaining({
      headers: { Authorization: `Bearer ${token}` },
    }));
    expect(app.panelScope).toBe('partner');
    expect(app.panelModules).toEqual(['resumo', 'colaboradores', 'catalogo']);
    expect(app.panelModules).not.toContain('marketing');
    expect(app.panelModules).not.toContain('bot');
    expect(app.panelModules).not.toContain('rede');
    expect(app.adminUser).toBeNull();
  });

  it('carrega somente as três fontes auditadas e preserva os totais do servidor', async () => {
    const sandbox: Record<string, any> = {
      window: {}, lucide: { createIcons() {} }, performance: { now: () => Date.now() },
    };
    runInNewContext(source('painel/public/app.partner-resumo.js'), sandbox);
    const apiGet = vi.fn(async (resource: string) => {
      if (resource === 'resumo') return { rows: [{ sales_month: '450.00', confirmed_result_month: '210.00' }] };
      if (resource === 'comissao/equipe') return { rows: [{ username: 'ana', gross_sales: 100 }], total_commission: 5 };
      return { finalized_sales: 2, gross_sales: 90, commission_amount: 4.5 };
    });
    const app: any = {
      isPartnerPanel: () => true,
      hasPanelModule: () => true,
      partnerApiGet: apiGet,
      partnerPanelTelemetry: vi.fn(),
      partnerPanelErrorCode: () => 'api_error',
      $nextTick: (callback: () => void) => callback(),
    };
    Object.defineProperties(
      app, Object.getOwnPropertyDescriptors(sandbox.window.PAINEL_MODULES.partnerResumo()),
    );

    await app.loadPartnerResumo();

    expect(apiGet.mock.calls.map(([resource]) => resource)).toEqual([
      'resumo', 'comissao/equipe', 'meu-desempenho',
    ]);
    expect(app.partnerResumoData.confirmed_result_month).toBe('210.00');
    expect(app.partnerResumoTeam.total_commission).toBe(5);
    expect(app.partnerResumoSelf.commission_amount).toBe(4.5);
  });

  it('publica a tela no casco sem expor tokenId no /me do parceiro', () => {
    const html = source('painel/public/index.html');
    const staticRoute = source('src/admin/painel/route-static.ts');
    const partnerRoute = source('src/parceiro/route.ts');

    expect(html).toContain("currentPage === 'resumo' && isPartnerPanel()");
    expect(html).toContain('partnerResumoData?.confirmed_result_month');
    expect(html).toContain('partnerResumoData?.cash_net_month');
    expect(html).toContain('partnerResumoData?.open_receivables_total');
    expect(staticRoute).toContain("'app.partner-api.js'");
    expect(staticRoute).toContain("'app.partner-resumo.js'");
    const meHandler = partnerRoute.slice(
      partnerRoute.indexOf("fastify.get('/parceiro/:slug/api/me'"),
      partnerRoute.indexOf('// Etapa 4c'),
    );
    expect(meHandler).not.toContain('tokenId');
    expect(meHandler).not.toContain('token_id');
  });
});
