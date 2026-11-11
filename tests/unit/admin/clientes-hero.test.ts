import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Clientes — cabeçalho de texto', () => {
  it('remove o banner de Clientes e preserva exportação e navegação', () => {
    const html = readFileSync(resolve('painel/public/index.html'), 'utf8');
    const staticRoutes = readFileSync(resolve('src/admin/painel/route-static.ts'), 'utf8');

    expect(html.includes('/admin/painel/assets/clientes-hero.webp?v=20260729-clientes-banner1')).toBe(false);
    expect(html).toContain('aria-labelledby="clientes-heading"');
    expect(html).toContain('id="clientes-heading"');
    expect(html).toContain('aria-label="Seções de Clientes"');
    expect(html).toContain('Relacionamento, atendimento e recompra em uma visão única');
    expect(html).toContain('@click="exportarClientes()"');
    expect(html).toContain('@click="setClientesTab(tab.id)"');
    expect(html.includes('class="cc-header"')).toBe(true);
    expect(staticRoutes).toContain("fastify.get('/admin/painel/assets/clientes-hero.webp'");
    expect(staticRoutes).toContain("'assets/clientes-hero.webp'");
  });
});
