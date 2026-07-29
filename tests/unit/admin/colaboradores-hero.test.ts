import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Colaboradores — cabeçalho panorâmico', () => {
  it('serve o banner 2W e preserva a navegação e o cadastro da equipe', () => {
    const html = readFileSync(resolve('painel/public/index.html'), 'utf8');
    const staticRoutes = readFileSync(resolve('src/admin/painel/route-static.ts'), 'utf8');
    const banner = statSync(resolve('painel/public/assets/colaboradores-hero.webp'));

    expect(html).toContain('/admin/painel/assets/colaboradores-hero.webp?v=20260729-colaboradores-banner1');
    expect(html).toContain('aria-labelledby="colaboradores-heading"');
    expect(html).toContain('id="colaboradores-heading"');
    expect(html).toContain('aria-label="Seções de Colaboradores"');
    expect(html).toContain('min-h-[148px]');
    expect(html).toContain('bg-gradient-to-r from-emerald-950 via-emerald-950/75 to-emerald-950/5');
    expect(html).toContain('@click="abrirNovoColaborador()"');
    expect(html).toContain('@click="colabSetTab(tab.id)"');
    expect(staticRoutes).toContain("fastify.get('/admin/painel/assets/colaboradores-hero.webp'");
    expect(staticRoutes).toContain("'assets/colaboradores-hero.webp'");
    expect(banner.size).toBeGreaterThan(0);
    expect(banner.size).toBeLessThan(100_000);
  });
});
