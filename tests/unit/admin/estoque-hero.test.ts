import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Estoque — cabeçalho panorâmico', () => {
  it('preserva a operação existente e serve o hero WebP do galpão', () => {
    const html = readFileSync(resolve('painel/public/index.html'), 'utf8');
    const staticRoutes = readFileSync(resolve('src/admin/painel/route-static.ts'), 'utf8');
    const banner = statSync(resolve('painel/public/assets/estoque-hero.webp'));
    const previewBanner = statSync(resolve('painel/public/assets/estoque-hero-warehouse.webp'));
    const tireThumbnail = statSync(resolve('painel/public/assets/tire-dashboard.webp'));

    expect(html).toContain('/admin/painel/assets/estoque-hero.webp?v=20260723-estoque-rede1');
    expect(html).toContain('/admin/painel/assets/estoque-hero.webp?preview=warehouse&v=20260724-estoque-banner-preview3');
    expect(html).toContain('aria-labelledby="estoque-heading"');
    expect(html).toContain('id="estoque-heading"');
    expect(html).toContain('aria-label="Seções de Estoque"');
    expect(html).toContain('xl:grid-cols-[380px_minmax(0,1fr)]');
    expect(html).toContain('min-h-[148px]');
    expect(html).toContain("'absolute inset-0 rounded-t-xl'");
    expect(html).toContain("'relative rounded-xl'");
    expect(html).toContain("'relative z-20 justify-center px-8 py-6 xl:px-10'");
    expect(html).toContain("'from-emerald-950 via-emerald-950/75 to-emerald-950/5'");
    expect(html).toContain('galpão oficial');
    expect(html).toContain("stockTab = 'movimentacoes'; loadGalpaoFilme()");
    expect(html).toContain("stockTab = 'conciliacao'; loadStockReconciliation()");
    expect(html).toContain("stockOperacao = 'entrada'");
    expect(html).toContain("stockOperacao = 'ajuste'");
    expect(staticRoutes).toContain("fastify.get('/admin/painel/assets/estoque-hero.webp'");
    expect(staticRoutes).toContain(": 'assets/estoque-hero.webp';");
    expect(staticRoutes).toContain("query.preview === 'warehouse'");
    expect(staticRoutes).toContain("'assets/estoque-hero-warehouse.webp'");
    expect(staticRoutes).toContain("query.preview === 'tire'");
    expect(staticRoutes).toContain("'assets/tire-dashboard.webp'");
    expect(banner.size).toBeGreaterThan(0);
    expect(banner.size).toBeLessThan(100_000);
    expect(previewBanner.size).toBeGreaterThan(0);
    expect(previewBanner.size).toBeLessThan(100_000);
    expect(tireThumbnail.size).toBeGreaterThan(0);
    expect(tireThumbnail.size).toBeLessThan(100_000);
  });
});
