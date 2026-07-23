import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Compras — cabeçalho panorâmico', () => {
  it('referencia e serve o hero WebP pela rota estática do painel', () => {
    const html = readFileSync(resolve('painel/public/index.html'), 'utf8');
    const staticRoutes = readFileSync(resolve('src/admin/painel/route-static.ts'), 'utf8');
    const banner = statSync(resolve('painel/public/assets/compras-hero.webp'));

    expect(html).toContain("url('/admin/painel/assets/compras-hero.webp?v=20260723-compras1')");
    expect(html).toContain('aria-labelledby="compras-heading"');
    expect(html).toContain('id="compras-heading"');
    expect(staticRoutes).toContain("fastify.get('/admin/painel/assets/compras-hero.webp'");
    expect(staticRoutes).toContain("'assets/compras-hero.webp', 'image/webp'");
    expect(banner.size).toBeGreaterThan(0);
    expect(banner.size).toBeLessThan(100_000);
  });
});
