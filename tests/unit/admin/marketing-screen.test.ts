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
    expect(html).toContain('/admin/painel/app.marketing.js?v=20260725-marketing-visao3');
    expect(html).toContain('/admin/painel/tailwind.css?v=20260725-marketing-visao3');
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

  it('apresenta uma leitura fluida e marcas reais sem alterar o contrato de dados', () => {
    const marketingStart = html.indexOf('<div x-show="currentPage === \'marketing\'"');
    const marketingEnd = html.indexOf('TELA: PLACEHOLDERS', marketingStart);
    const marketingHtml = html.slice(marketingStart, marketingEnd);

    expect(front).toContain('marketingSeriesPoints(field, area = false)');
    expect(front).toContain('const controlX = (current.x + next.x) / 2');
    expect(marketingHtml).toContain('marketingJourneyLine');
    expect(marketingHtml).toContain('Uma trilha contínua; nenhuma etapa avança sem evidência');
    expect(marketingHtml).toContain('/assets/brands/facebook.svg');
    expect(marketingHtml).toContain('/assets/brands/instagram.svg');
    expect(marketingHtml).toContain('/assets/brands/google-ads.svg');
    expect(marketingHtml).toContain('<title>TikTok</title>');
    expect(marketingHtml).toContain('grid grid-cols-1 gap-2 sm:grid-cols-3');
    expect(marketingHtml).toContain('background:conic-gradient(#047857');
    expect(marketingHtml).toContain('<strong>Próximo passo:</strong> validar atribuição CTWA');
    expect(marketingHtml).toContain('data-marketing-channel-filter-mock');
    expect(marketingHtml).toContain('Estes botões ainda NÃO filtram os dados');
    expect(marketingHtml).toContain('channels=meta,google,tiktok');
    expect(marketingHtml).toContain('Prévia dos filtros — os valores atuais ainda usam somente a Meta');
    expect(marketingHtml).not.toContain('<section x-show="marketingIsMock()" x-cloak data-marketing-channel-filter-mock');
    expect(marketingHtml).toContain('grid grid-cols-1 gap-4 lg:grid-cols-12');
    expect(marketingHtml).toContain('shadow-sm lg:col-span-8');
    expect(marketingHtml).toContain('shadow-sm lg:col-span-7');
    expect(marketingHtml).toContain('absolute right-3 top-3 z-20');
    expect(marketingHtml).not.toContain('absolute right-3 top-3 z-30');
    expect(marketingHtml).toContain('xl:grid-cols-6');
    expect(marketingHtml).not.toContain('h-4.5 w-4.5');
    expect(front).toContain("'border-emerald-300 bg-emerald-100/80 text-emerald-950'");
    expect(front).not.toContain("'border-rose-200 bg-rose-50 text-rose-700'");
  });
});
