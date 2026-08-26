import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Colaboradores — cabeçalho panorâmico', () => {
  it('serve o banner 2W e preserva a navegação e o cadastro da equipe', () => {
    const html = readFileSync(resolve('painel/public/index.html'), 'utf8');
    const staticRoutes = readFileSync(resolve('src/admin/painel/route-static.ts'), 'utf8');
    const banner = statSync(resolve('painel/public/assets/colaboradores-hero-v2.webp'));

    expect(html).toContain('/admin/painel/assets/colaboradores-hero-v2.webp?v=20260826-colaboradores-banner2');
    expect(html).toContain('aria-labelledby="colaboradores-heading"');
    expect(html).toContain('id="colaboradores-heading"');
    expect(html).toContain('aria-label="Seções de Colaboradores"');
    expect(html).not.toContain('style="aspect-ratio: 5 / 1;"');
    expect(html).toContain('/admin/painel/tailwind.css?v=20260826-colab-banner3');
    expect(html.match(/style="min-height: 148px;"/g)).toHaveLength(2);
    expect(html).toContain('class="absolute inset-0 h-full w-full object-fill object-center"');
    expect(html).toContain('class="grid items-start gap-4 md:grid-cols-5 xl:grid-cols-3"');
    expect(html).toContain('md:col-span-2 xl:col-span-1');
    expect(html).toContain('md:col-span-3 xl:col-span-2');
    expect(html).toContain('class="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center"');
    expect(html).toContain('@click="abrirNovoColaborador()"');
    expect(html).toContain('@click="colabSetTab(tab.id)"');
    expect(staticRoutes).toContain("fastify.get('/admin/painel/assets/colaboradores-hero-v2.webp'");
    expect(staticRoutes).toContain("'assets/colaboradores-hero-v2.webp'");
    expect(banner.size).toBeGreaterThan(0);
    expect(banner.size).toBeLessThan(100_000);
  });
});
