import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Clientes — cabeçalho panorâmico', () => {
  it('serve o banner 2W e preserva exportação e navegação', () => {
    const html = readFileSync(resolve('painel/public/index.html'), 'utf8');
    const staticRoutes = readFileSync(resolve('src/admin/painel/route-static.ts'), 'utf8');
    const banner = statSync(resolve('painel/public/assets/clientes-hero.webp'));

    expect(html).toContain('/admin/painel/assets/clientes-hero.webp?v=20260729-clientes-banner1');
    expect(html).toContain('aria-labelledby="clientes-heading"');
    expect(html).toContain('id="clientes-heading"');
    expect(html).toContain('aria-label="Seções de Clientes"');
    expect(html).toContain('Relacionamento, atendimento e recompra em uma visão única');
    expect(html).toContain('@click="exportarClientes()"');
    expect(html).toContain('@click="setClientesTab(tab.id)"');
    expect(html).toContain('min-h-[148px]');
    expect(html).toContain('bg-gradient-to-r from-emerald-950 via-emerald-950/75 to-emerald-950/5');
    expect(staticRoutes).toContain("fastify.get('/admin/painel/assets/clientes-hero.webp'");
    expect(staticRoutes).toContain("'assets/clientes-hero.webp'");
    expect(banner.size).toBeGreaterThan(0);
    expect(banner.size).toBeLessThan(100_000);
  });
});
