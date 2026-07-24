import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Vendas — cabeçalho panorâmico', () => {
  it('referencia e serve o hero WebP pela rota estática do painel', () => {
    const html = readFileSync(resolve('painel/public/index.html'), 'utf8');
    const staticRoutes = readFileSync(resolve('src/admin/painel/route-static.ts'), 'utf8');
    const banner = statSync(resolve('painel/public/assets/vendas-hero.webp'));

    expect(html).toContain('/admin/painel/assets/vendas-hero.webp?v=20260723-vendas-rede2');
    expect(html).toContain('aria-labelledby="vendas-heading"');
    expect(html).toContain('id="vendas-heading"');
    expect(html).toContain('xl:grid-cols-[380px_minmax(0,1fr)]');
    expect(html).toContain('min-h-[148px]');
    expect(html).toContain('aria-label="Seções de Vendas"');
    expect(html).toContain('vendas reais');
    expect(html).toContain('vendasHistoricoPeriodoLabel()');
    expect(staticRoutes).toContain("fastify.get('/admin/painel/assets/vendas-hero.webp'");
    expect(staticRoutes).toContain("'assets/vendas-hero.webp', 'image/webp'");
    expect(banner.size).toBeGreaterThan(0);
    expect(banner.size).toBeLessThan(100_000);
  });
});
