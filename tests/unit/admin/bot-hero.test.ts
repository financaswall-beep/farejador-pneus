import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Bot — cabeçalho panorâmico', () => {
  it('usa o banner do Bot no padrão da Rede, mantém título e filtros em HTML e serve WebP leve', () => {
    const html = readFileSync(resolve('painel/public/index.html'), 'utf8');
    const staticRoutes = readFileSync(resolve('src/admin/painel/route-static.ts'), 'utf8');
    const banner = statSync(resolve('painel/public/assets/bot-hero.webp'));
    const botHeroStart = html.indexOf('<section aria-labelledby="bot-heading"');
    const botHero = html.slice(botHeroStart, html.indexOf('</section>', botHeroStart));

    expect(html).toContain('/admin/painel/assets/bot-hero.webp?v=20260723-bot-rede2');
    expect(html).toContain('aria-labelledby="bot-heading"');
    expect(html).toContain('xl:grid-cols-[380px_minmax(0,1fr)]');
    expect(html).toContain('min-h-[148px]');
    expect(html).toContain('id="bot-heading"');
    expect(html).toContain('aria-label="Seções do Bot"');
    expect(html).toContain('aria-label="Período do Bot"');
    expect(botHero).not.toContain('aria-label="Período do Bot"');
    expect(botHero).toContain('dados reais');
    expect(botHero).toContain("botPeriodo === 'today'");
    expect(html).toContain('Atenda clientes no WhatsApp, acompanhe conversas');
    expect(staticRoutes).toContain("fastify.get('/admin/painel/assets/bot-hero.webp'");
    expect(staticRoutes).toContain("'assets/bot-hero.webp', 'image/webp'");
    expect(banner.size).toBeGreaterThan(0);
    expect(banner.size).toBeLessThan(100_000);
  });
});
