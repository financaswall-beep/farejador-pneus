import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Bot — cabeçalho panorâmico', () => {
  it('usa o fundo do Bot, mantém título e filtros em HTML e serve WebP leve', () => {
    const html = readFileSync(resolve('painel/public/index.html'), 'utf8');
    const staticRoutes = readFileSync(resolve('src/admin/painel/route-static.ts'), 'utf8');
    const banner = statSync(resolve('painel/public/assets/bot-hero.webp'));
    const botHeroStart = html.indexOf('<section aria-labelledby="bot-heading"');
    const botHero = html.slice(botHeroStart, html.indexOf('</section>', botHeroStart));

    expect(html).toContain("url('/admin/painel/assets/bot-hero.webp?v=20260718-bot1')");
    expect(html).toContain('aria-labelledby="bot-heading"');
    expect(html).toContain('relative -mx-8 -mt-8 mb-5 min-h-[260px]');
    expect(html).toContain('id="bot-heading"');
    expect(html).toContain('md:flex-row md:items-center md:justify-between');
    expect(html).toContain('aria-label="Período do Bot"');
    expect(botHero).not.toContain('absolute right-8 top-5 z-10');
    expect(botHero).not.toContain('aria-label="Período do Bot"');
    expect(html).toContain('bg-gradient-to-r from-slate-950 via-slate-900 to-emerald-600');
    expect(html).toContain('Atenda clientes no WhatsApp, acompanhe conversas');
    expect(staticRoutes).toContain("fastify.get('/admin/painel/assets/bot-hero.webp'");
    expect(staticRoutes).toContain("'assets/bot-hero.webp', 'image/webp'");
    expect(banner.size).toBeGreaterThan(0);
    expect(banner.size).toBeLessThan(100_000);
  });
});
