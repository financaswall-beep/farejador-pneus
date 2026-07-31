import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import type { Pool } from 'pg';
import { beforeAll, describe, expect, it, vi } from 'vitest';

let getSalesBrandRanking:
  typeof import('../../../src/admin/painel/queries-vendas-marcas.js').getSalesBrandRanking;

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
    CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'emergency-token',
  });
  ({ getSalesBrandRanking }
    = await import('../../../src/admin/painel/queries-vendas-marcas.js'));
});

function frontendModule() {
  const sandbox = {
    window: { PAINEL_MODULES: {}, lucide: null },
    location: { pathname: '/admin/painel' },
    encodeURIComponent,
    Error,
  };
  vm.runInNewContext(readFileSync('painel/public/app.vendas.marcas.js', 'utf8'), sandbox);
  return sandbox.window.PAINEL_MODULES.vendasMarcas();
}

describe('ranking de marcas em Vendas', () => {
  it('consolida varejo e atacado por marca, quantidade e faturamento', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [
      { brand: 'Pirelli', channel: 'varejo', units: '3', revenue: '450.00' },
      { brand: 'Pirelli', channel: 'atacado', units: '2', revenue: '200.00' },
      { brand: 'Metzeler', channel: 'varejo', units: '4', revenue: '480.00' },
      { brand: 'Magion', channel: 'varejo', units: '1', revenue: '100.00' },
      { brand: 'Maggion', channel: 'atacado', units: '2', revenue: '220.00' },
    ] });

    const result = await getSalesBrandRanking('7d', 'test', { query } as unknown as Pool);

    expect(query).toHaveBeenCalledWith(expect.stringContaining("u.slug='main'"), ['test', '7d']);
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("o.status IN ('confirmed','paid','delivered')");
    expect(sql).toContain("o.status='confirmed'");
    expect(sql).toContain("p.product_type='tire'");
    expect(result.summary).toEqual({ brands: 3, units: 12, revenue: 1450 });
    expect(result.rows).toEqual([
      expect.objectContaining({ rank: 1, brand: 'Pirelli', units: 5, revenue: 650,
        retail_units: 3, wholesale_units: 2, share_percent: 41.7 }),
      expect.objectContaining({ rank: 2, brand: 'Metzeler', units: 4, revenue: 480,
        retail_units: 4, wholesale_units: 0, share_percent: 33.3 }),
      expect.objectContaining({ rank: 3, brand: 'Maggion', units: 3, revenue: 320,
        retail_units: 1, wholesale_units: 2, share_percent: 25 }),
    ]);
  });

  it('carrega o mesmo período selecionado pela tela sem derrubar os demais dados', async () => {
    const module = frontendModule();
    const context = {
      ...module,
      vendasPeriodo: '30d', adminAuthenticated: true,
      ensureCredentials: vi.fn(),
      apiGet: vi.fn().mockResolvedValue({
        period: '30d', summary: { brands: 1, units: 5, revenue: 650 },
        rows: [{ rank: 1, brand: 'Pirelli', units: 5 }],
      }),
      $nextTick: (callback: () => void) => callback(),
    };

    await module.loadVendasMarcas.call(context);

    expect(context.apiGet).toHaveBeenCalledWith('/admin/api/sales/brands?period=30d');
    expect(context.vendasMarcas.rows).toEqual([
      expect.objectContaining({ rank: 1, brand: 'Pirelli', units: 5 }),
    ]);
    expect(context.vendasMarcasLoading).toBe(false);
    expect(context.vendasMarcasError).toBeNull();
  });

  it('expõe o ranking na Visão geral e registra o módulo estático', () => {
    const html = readFileSync('painel/public/index.html', 'utf8');
    const montagem = readFileSync('painel/public/app.montagem.js', 'utf8');
    const staticRoutes = readFileSync('src/admin/painel/route-static.ts', 'utf8');
    expect(html).toContain('data-testid="sales-brand-ranking"');
    expect(html).toContain('Marcas mais vendidas');
    expect(html).toContain('Vendas confirmadas da Matriz · varejo + atacado');
    expect(html).toContain('app.vendas.marcas.js?v=20260731-vendas-marcas1');
    expect(montagem).toContain('window.PAINEL_MODULES.vendasMarcas');
    expect(staticRoutes).toContain("'app.vendas.marcas.js'");
  });
});
