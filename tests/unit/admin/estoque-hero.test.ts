import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Estoque — cabeçalho panorâmico', () => {
  it('preserva a operação existente e serve o hero WebP do galpão', () => {
    const html = readFileSync(resolve('painel/public/index.html'), 'utf8');
    const staticRoutes = readFileSync(resolve('src/admin/painel/route-static.ts'), 'utf8');
    const banner = statSync(resolve('painel/public/assets/estoque-hero.webp'));

    expect(html).toContain('/admin/painel/assets/estoque-hero.webp?v=20260723-estoque-rede1');
    expect(html).toContain('aria-labelledby="estoque-heading"');
    expect(html).toContain('id="estoque-heading"');
    expect(html).toContain('aria-label="Seções de Estoque"');
    expect(html).toContain('xl:grid-cols-[380px_minmax(0,1fr)]');
    expect(html).toContain('min-h-[148px]');
    expect(html).toContain('galpão oficial');
    expect(html).toContain("stockTab = 'movimentacoes'; loadGalpaoFilme()");
    expect(html).toContain("stockTab = 'conciliacao'; loadStockReconciliation()");
    expect(html).toContain("stockOperacao = 'entrada'");
    expect(html).toContain("stockOperacao = 'ajuste'");
    expect(staticRoutes).toContain("fastify.get('/admin/painel/assets/estoque-hero.webp'");
    expect(staticRoutes).toContain("'assets/estoque-hero.webp', 'image/webp'");
    expect(banner.size).toBeGreaterThan(0);
    expect(banner.size).toBeLessThan(100_000);
  });
});
