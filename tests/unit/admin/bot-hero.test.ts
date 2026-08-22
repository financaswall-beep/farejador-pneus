import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Bot — cabeçalho compacto', () => {
  it('mantém título, descrição e abas acima do movimento sem o banner antigo', () => {
    const html = readFileSync(resolve('painel/public/index.html'), 'utf8');
    const botHeroStart = html.indexOf('<section aria-labelledby="bot-heading"');
    const botHero = html.slice(botHeroStart, html.indexOf('</section>', botHeroStart));

    expect(html).toContain('aria-labelledby="bot-heading"');
    expect(html).toContain('id="bot-heading"');
    expect(html).toContain('aria-label="Seções do Bot"');
    expect(html).toContain('aria-label="Período do Bot"');
    expect(botHero).not.toContain('aria-label="Período do Bot"');
    expect(botHero).toContain('Conversas, pedidos e desempenho do atendimento automático');
    expect(botHero).not.toContain('bot-hero.webp');
    expect(html).toContain('Movimento do Bot');
    expect(html).toContain('lg:flex-row lg:items-center');
  });
});
