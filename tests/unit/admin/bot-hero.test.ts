import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Bot — cabeçalho e composição compacta', () => {
  it('mantém o banner compacto e distribui movimento e situação operacional em 8/4 colunas', () => {
    const html = readFileSync(resolve('painel/public/index.html'), 'utf8');
    const botHeroStart = html.indexOf('<section aria-labelledby="bot-heading"');
    const botHero = html.slice(botHeroStart, html.indexOf('</section>', botHeroStart));

    expect(html).toContain('aria-labelledby="bot-heading"');
    expect(html).toContain('id="bot-heading"');
    expect(html).toContain('aria-label="Seções do Bot"');
    expect(html).toContain('aria-label="Período do Bot"');
    expect(botHero).not.toContain('aria-label="Período do Bot"');
    expect(botHero).toContain('Conversas, pedidos e desempenho do atendimento automático');
    expect(botHero).toContain('/admin/painel/assets/bot-hero.webp?v=20260723-bot-rede2');
    expect(botHero).toContain('min-h-[132px]');
    expect(html).toContain('Movimento do Bot');
    expect(html).toContain('xl:col-span-8');
    expect(html).toContain('aria-label="Situação operacional do Bot"');
    expect(html).toContain('min-[1500px]:grid-cols-4');
  });
});
