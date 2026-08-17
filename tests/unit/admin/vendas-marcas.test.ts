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
    const commercialVisionStart = html.indexOf('data-testid="sales-commercial-vision"');
    const commercialVision = html.slice(
      commercialVisionStart,
      html.indexOf('</section>', commercialVisionStart) + '</section>'.length,
    );
    expect(html).toContain('data-testid="sales-commercial-vision" class="space-y-3"');
    expect(html).toContain('data-testid="sales-channel-performance" class="relative overflow-hidden rounded-xl border border-gray-200 bg-white p-4 xl:col-span-5 xl:h-[220px]"');
    expect(html).toContain('data-testid="sales-commercial-focus" class="relative overflow-hidden rounded-xl border border-amber-300 bg-amber-50 p-4 xl:col-span-3 xl:h-[220px]"');
    expect(html).toContain('data-testid="sales-brand-ranking" class="rounded-xl border border-gray-200 bg-white p-4 xl:col-span-4 xl:h-[220px]"');
    expect(html).toContain('Placar comercial');
    expect(html).toContain('Faturamento confirmado');
    expect(html).toContain('Próxima jogada');
    expect(html).toContain('Marcas que puxam receita');
    expect(html).toContain('grid grid-cols-1 gap-3 xl:grid-cols-12');
    expect(commercialVision).toContain('vendasMarcas.rows.slice(0, 2)');
    expect(commercialVision).not.toContain('catalogoBrandLogo(marca.brand)');
    expect(commercialVision).not.toContain('bg-gradient');
    expect(commercialVision).not.toContain('shadow');
    expect(html).toContain('app.vendas.marcas.js?v=20260817-sales-integrity1');
    expect(montagem).toContain('window.PAINEL_MODULES.vendasMarcas');
    expect(staticRoutes).toContain("'app.vendas.marcas.js'");
  });
});
