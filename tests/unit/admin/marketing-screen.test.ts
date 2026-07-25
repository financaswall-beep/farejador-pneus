import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Marketing — primeira tela da matriz', () => {
  const html = readFileSync(resolve('painel/public/index.html'), 'utf8');
  const front = readFileSync(resolve('painel/public/app.marketing.js'), 'utf8');
  const route = readFileSync(resolve('src/admin/painel/route-marketing.ts'), 'utf8');
  const staticRoute = readFileSync(resolve('src/admin/painel/route-static.ts'), 'utf8');

  it('preserva o molde do Estoque com banner real e subabas superiores', () => {
    const banner = statSync(resolve('painel/public/assets/marketing-hero.webp'));
    const marketingStart = html.indexOf('<div x-show="currentPage === \'marketing\'"');
    const marketingEnd = html.indexOf('TELA: PLACEHOLDERS', marketingStart);
    const marketingHtml = html.slice(marketingStart, marketingEnd);

    expect(marketingHtml).toContain('min-h-[148px]');
    expect(marketingHtml).toContain('/admin/painel/assets/marketing-hero.webp?v=20260725-marketing-visao1');
    expect(marketingHtml).toContain('aria-label="Seções de Marketing"');
    for (const label of [
      'Visão geral',
      'Canais',
      'Campanhas',
      'Criativos',
      'Jornadas',
      'Geografia e demanda',
      'Integrações',
    ]) expect(front).toContain(label);
    expect(banner.size).toBeGreaterThan(0);
    expect(banner.size).toBeLessThan(100_000);
  });

  it('liga o front a um endpoint owner-only sem expor credenciais', () => {
    expect(front).toContain('/admin/api/marketing/overview?period=');
    expect(route).toContain("{ preHandler: requireAdminOwner }");
    expect(route).toContain("z.enum(['7d', '30d'])");
    expect(staticRoute).toContain("'app.marketing.js'");
    expect(staticRoute).toContain("fastify.get('/admin/painel/assets/marketing-hero.webp'");
    expect(front).not.toMatch(/META_ADS_ACCESS_TOKEN|access_token=/);
    expect(html).not.toMatch(/META_ADS_ACCESS_TOKEN|access_token=/);
  });

  it('não transforma ausência de atribuição em venda zero', () => {
    expect(front).toContain("attributed_sales: null");
    expect(front).toContain("profit: null");
    expect(html).toContain('zero vendas atribuídas não significa zero vendas realizadas');
    expect(html).toContain('A venda só entra aqui depois de haver vínculo rastreável');
  });
});
