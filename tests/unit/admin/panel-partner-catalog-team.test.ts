import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = (path: string) => readFileSync(resolve(path), 'utf8');

function moduleOf(file: string, name: string) {
  const sandbox: Record<string, any> = {
    window: {}, encodeURIComponent, Intl, Date, Map,
    lucide: { createIcons() {} },
  };
  runInNewContext(source(file), sandbox, { filename: file });
  return sandbox.window.PAINEL_MODULES[name]();
}

function appWith(module: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  const app: any = {
    isPartnerPanel: () => true,
    panelWorkplace: { role: 'owner' },
    partnerApiGet: vi.fn(), partnerApiWrite: vi.fn(),
    $nextTick: (callback: Function) => callback(),
    ...overrides,
  };
  Object.defineProperties(app, Object.getOwnPropertyDescriptors(module));
  return app;
}

describe('módulos isolados de catálogo e colaboradores do parceiro', () => {
  it('carrega catálogo paginado apenas pela API do parceiro', async () => {
    const api = vi.fn().mockResolvedValue({
      page: 1, limit: 40, total: 1, pages: 1, brands: ['Pirelli'],
      rows: [{ product_id: 'p1', product_type: 'tire', tire_size: '130/70-17' }],
    });
    const app = appWith(moduleOf(
      'painel/public/app.partner-catalogo.js', 'partnerCatalogo',
    ), { partnerApiGet: api });
    app.partnerCatalogo.q = '130/70';
    app.partnerCatalogo.brand = 'Pirelli';
    app.partnerCatalogo.type = 'tire';
    app.partnerCatalogo.filter = 'stock';

    await app.loadPartnerCatalogo(1);

    expect(api).toHaveBeenCalledWith(
      'painel/catalogo?page=1&limit=40&q=130%2F70&brand=Pirelli&type=tire&filter=stock',
    );
    expect(app.partnerCatalogo.rows).toHaveLength(1);
    expect(app.partnerCatalogo.total).toBe(1);
  });

  it('abre a compatibilidade e preserva preço como dado do servidor', async () => {
    const api = vi.fn().mockResolvedValue({
      product: { product_id: 'p1', tire_size: '90/90-18' },
      summary: { models: 1, fitments: 1 },
      rows: [{ make: 'Honda', model: 'CG 150 Titan', position: 'rear' }],
    });
    const app = appWith(moduleOf(
      'painel/public/app.partner-catalogo.js', 'partnerCatalogo',
    ), { partnerApiGet: api });

    await app.partnerCatalogoOpenCompatibility({ product_id: 'p1', product_type: 'tire' });

    expect(api).toHaveBeenCalledWith('painel/catalogo/p1/compatibilidade');
    expect(app.partnerCatalogo.compatibility).toHaveLength(1);
    expect(app.partnerCatalogoPrice({ local_sale_price_min: 89, local_sale_price_max: 99 }))
      .toEqual({ min: 89, max: 99 });
  });

  it('não carrega catálogo nem equipe para funcionário', async () => {
    const catalogApi = vi.fn();
    const catalog = appWith(moduleOf(
      'painel/public/app.partner-catalogo.js', 'partnerCatalogo',
    ), { panelWorkplace: { role: 'funcionario' }, partnerApiGet: catalogApi });
    const teamApi = vi.fn();
    const team = appWith(moduleOf(
      'painel/public/app.partner-colaboradores.js', 'partnerColaboradores',
    ), { panelWorkplace: { role: 'funcionario' }, partnerApiGet: teamApi });

    await catalog.loadPartnerCatalogo();
    await team.loadPartnerColaboradores();

    expect(catalogApi).not.toHaveBeenCalled();
    expect(teamApi).not.toHaveBeenCalled();
  });

  it('une equipe e contas da mesma unidade sem consultar folha da Matriz', async () => {
    const api = vi.fn()
      .mockResolvedValueOnce({ members: [{ id: 'u1', name: 'Ana', active: true, job_role: 'vendedor' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'u1', username: 'ana', revoked_at: null, last_used_at: '2026-08-24' }] });
    const app = appWith(moduleOf(
      'painel/public/app.partner-colaboradores.js', 'partnerColaboradores',
    ), { partnerApiGet: api });

    await app.loadPartnerColaboradores();

    expect(api.mock.calls.map((call) => call[0])).toEqual(['equipe', 'funcionarios']);
    expect(app.partnerColaboradores.rows[0]).toEqual(expect.objectContaining({
      id: 'u1', name: 'Ana', username: 'ana', active: true,
    }));
    expect(app.partnerColaboradores.activeCount).toBe(1);
  });

  it('salva configuração no endpoint atômico já existente', async () => {
    const write = vi.fn().mockResolvedValue({ saved: true });
    const get = vi.fn().mockResolvedValueOnce({ members: [] }).mockResolvedValueOnce({ rows: [] });
    const app = appWith(moduleOf(
      'painel/public/app.partner-colaboradores.js', 'partnerColaboradores',
    ), { partnerApiWrite: write, partnerApiGet: get });
    app.partnerColaboradores.selected = { id: 'u1' };
    app.partnerColaboradores.detail.job_role = 'vendedor';
    app.partnerColaboradores.detail.permissions.vendas = true;

    await app.partnerColaboradoresSave();

    expect(write).toHaveBeenCalledWith('equipe/u1/configuracao', 'PUT', expect.objectContaining({
      job_role: 'vendedor',
      permissions: expect.objectContaining({ vendas: true, financeiro: false }),
      compensation: expect.any(Object), commission: expect.any(Object),
    }));
  });

  it('calcula a remuneração mensal sem misturar colaboradores inativos', () => {
    const finance = moduleOf(
      'painel/public/app.partner-colaboradores.finance.js', 'partnerColaboradoresFinance',
    );
    const app = appWith(finance, {
      formatCurrency: (value: number) => `R$ ${value}`,
      partnerColaboradores: {
        q: '', remunerationFilter: 'all', selected: null,
        commissionTotal: 80,
        rows: [
          { id: 'u1', active: true, base_salary: 1_200, salary_frequency: 'monthly', benefits_total: 100, commission_amount: 50 },
          { id: 'u2', active: true, base_salary: 300, salary_frequency: 'weekly', benefits_total: 25, commission_amount: 30 },
          { id: 'u3', active: false, base_salary: 9_000, salary_frequency: 'monthly', benefits_total: 0, commission_amount: 0 },
        ],
        detail: { compensation: { base_salary: 0, salary_frequency: 'monthly', benefits: [] } },
      },
    });

    expect(app.partnerColaboradoresMonthlySalaryTotal()).toBe(2_500);
    expect(app.partnerColaboradoresFinancialTotal(app.partnerColaboradores.rows[0])).toBe(1_350);
    expect(app.partnerColaboradoresRemunerationRows().map((row: any) => row.id)).toEqual(['u1', 'u2']);
  });

  it('expõe a subaba completa e libera seu módulo estático', () => {
    const html = source('painel/public/index.html');
    const staticRoute = source('src/admin/painel/route-static.ts');
    const montagem = source('painel/public/app.montagem.js');

    expect(html).toContain('Remuneração e comissões');
    expect(html).toContain('Remuneração da equipe');
    expect(html).toContain('Total previsto no mês');
    expect(html).toContain('partnerColaboradoresSave()');
    expect(staticRoute).toContain('app.partner-colaboradores.finance.js');
    expect(montagem).toContain('window.PAINEL_MODULES.partnerColaboradoresFinance');
  });

  it('cria, redefine senha e revoga usando só partnerApiWrite', async () => {
    const write = vi.fn().mockResolvedValue({ ok: true });
    const get = vi.fn().mockResolvedValue({ members: [], rows: [] });
    const app = appWith(moduleOf(
      'painel/public/app.partner-colaboradores.js', 'partnerColaboradores',
    ), { partnerApiWrite: write, partnerApiGet: get });
    app.partnerColaboradores.create = {
      open: true, name: 'Ana Souza', username: 'ana', password: 'Senha-forte-123',
      role: 'vendedor', error: '',
    };
    await app.partnerColaboradoresCreate();
    app.partnerColaboradores.selected = { id: 'u1' };
    app.partnerColaboradores.password = { open: true, value: 'Outra-senha-123', error: '' };
    await app.partnerColaboradoresResetPassword();
    await app.partnerColaboradoresSetActive({ id: 'u1' }, false);

    expect(write).toHaveBeenCalledWith('equipe', 'POST', expect.objectContaining({ username: 'ana' }));
    expect(write).toHaveBeenCalledWith('funcionarios/u1/reset-senha', 'POST', { password: 'Outra-senha-123' });
    expect(write).toHaveBeenCalledWith('funcionarios/u1', 'DELETE', {});
  });

  it('mantém os adaptadores pequenos e sem rotas/dados administrativos', () => {
    const catalog = source('painel/public/app.partner-catalogo.js');
    const team = source('painel/public/app.partner-colaboradores.js');
    const finance = source('painel/public/app.partner-colaboradores.finance.js');
    const permissions = source('painel/public/app.partner-colaboradores.permissions.js');
    expect(catalog.split(/\r?\n/).length).toBeLessThanOrEqual(300);
    expect(team.split(/\r?\n/).length).toBeLessThanOrEqual(300);
    expect(finance.split(/\r?\n/).length).toBeLessThanOrEqual(120);
    expect(permissions.split(/\r?\n/).length).toBeLessThanOrEqual(120);
    for (const body of [catalog, team, finance, permissions]) {
      expect(body).not.toContain('/admin/api');
      expect(body).not.toMatch(/\bapiGet\b|\bapiPost\b|\bapiPut\b/);
    }
    expect(catalog).not.toMatch(/average_cost|unit_cost|gross_profit|margin_percent/i);
    expect(team).not.toMatch(/matriz.*ledger|admin.*payroll/i);
  });
});
