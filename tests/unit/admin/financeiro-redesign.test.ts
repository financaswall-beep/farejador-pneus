import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Visão geral redesenhada do Financeiro', () => {
  const html = readFileSync(resolve('painel/public/index.html'), 'utf8');
  const staticRoutes = readFileSync(resolve('src/admin/painel/route-static.ts'), 'utf8');

  it('serve e referencia os dois ativos visuais do Financeiro', () => {
    const banner = statSync(resolve('painel/public/assets/financeiro-hero.webp'));
    const fechamento = statSync(resolve('painel/public/assets/financeiro-fechamento.webp'));

    expect(banner.size).toBeGreaterThan(20_000);
    expect(fechamento.size).toBeGreaterThan(20_000);
    expect(html).toContain('/admin/painel/assets/financeiro-hero.webp?v=20260727-financeiro-visao1');
    expect(html).toContain('/admin/painel/assets/financeiro-fechamento.webp?v=20260727-financeiro-visao1');
    expect(staticRoutes).toContain("fastify.get('/admin/painel/assets/financeiro-hero.webp'");
    expect(staticRoutes).toContain("'assets/financeiro-hero.webp', 'image/webp'");
    expect(staticRoutes).toContain("fastify.get('/admin/painel/assets/financeiro-fechamento.webp'");
    expect(staticRoutes).toContain("'assets/financeiro-fechamento.webp', 'image/webp'");
  });

  it('mantém as seis sub-abas e alimenta o resumo somente pelo livro central', () => {
    for (const label of [
      'Visão geral',
      'Cobranças',
      'Contas a pagar',
      'Despesas',
      'Lançamentos',
      'Indicadores',
    ]) {
      expect(html).toContain(`label: '${label}'`);
    }

    expect(html).toContain('financeiroVisao.verdade.competencia.lucro_confirmado');
    expect(html).toContain('financeiroVisao.verdade.caixa.movimento_liquido');
    expect(html).toContain('finFluxoPainel().buckets');
    expect(html).toContain("(finExtrato?.rows || []).slice(0, 4)");
    expect(html).toContain('financeiroVisao.verdade.conciliacao.origens');
    expect(html).not.toContain('Cálculo anterior × livro financeiro central');
    expect(html).not.toContain('financeiroVisao.leitura.comparison');
  });
});
