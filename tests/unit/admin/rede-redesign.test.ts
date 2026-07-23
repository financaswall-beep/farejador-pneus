import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Rede — apresentação e contratos auditados', () => {
  const html = readFileSync(resolve('painel/public/index.html'), 'utf8');
  const state = readFileSync(resolve('painel/public/app.js'), 'utf8');
  const nav = readFileSync(resolve('painel/public/app.nav.js'), 'utf8');
  const kpis = readFileSync(resolve('painel/public/app.unidade.kpis.js'), 'utf8');

  it('serve a imagem padrão da Rede e expõe as três visões sem duplicar o período', () => {
    const staticRoutes = readFileSync(resolve('src/admin/painel/route-static.ts'), 'utf8');
    const banner = statSync(resolve('painel/public/assets/rede-hero-v2.webp'));

    expect(html).toContain('/admin/painel/assets/rede-hero-v2.webp?v=20260723-rede-fix1');
    expect(html).not.toContain('/admin/painel/assets/rede-hero.png');
    expect(html).toContain('Rede conectada, desempenho que move');
    expect(html).toContain("setRedeSection('visao')");
    expect(html).toContain("setRedeSection('operacao')");
    expect(html).toContain("setRedeSection('parceiros')");
    expect(state).toContain("redeSection: 'visao'");
    expect(nav).toContain('setRedeSection(section)');
    expect(staticRoutes).toContain("fastify.get('/admin/painel/assets/rede-hero-v2.webp'");
    expect(staticRoutes).toContain("'assets/rede-hero-v2.webp', 'image/webp'");
    expect(banner.size).toBeGreaterThan(0);
    expect(banner.size).toBeLessThan(150_000);
  });

  it('não exibe telas cruas no refresh nem troca a interface pelo fallback antigo', () => {
    const staticRoutes = readFileSync(resolve('src/admin/painel/route-static.ts'), 'utf8');

    expect(html).toContain('<div class="flex h-screen overflow-hidden" x-cloak>');
    expect(html).toContain('/admin/painel/vendor/alpine-3.14.9.min.js');
    expect(html).toContain('/admin/painel/vendor/chart-4.4.7.umd.min.js');
    expect(html).toContain('/admin/painel/vendor/lucide-1.17.0.min.js');
    expect(html).not.toContain('<script defer src="/admin/painel/rede-fallback.js');
    expect(html).not.toContain('https://unpkg.com');
    expect(html).not.toContain('https://cdn.jsdelivr.net');
    expect(staticRoutes).toContain("reply.header('Cache-Control', 'no-store')");
  });

  it('mantém a visão da unidade em quatro cards por linha e separa compra de CMV', () => {
    expect(html).toContain("x-show=\"unidadeTab === 'visao'\" class=\"grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4");
    expect(html).toContain('CMV (custo vendido)');
    expect(html).toContain('formatCurrency(selectedParceiro()?.cogsValor)');
    expect(html).toContain('formatCurrency(selectedParceiro()?.comprasPneus)');
  });

  it('preserva estoque desconhecido e deixa lançamentos da matriz somente leitura', () => {
    expect(html).toContain("item.qtd === null ? 'não controlado' : item.qtd");
    expect(kpis).toContain("item.qtd === null ? 0 : Number(item.qtd || 0)");
    expect(html).toContain('somente leitura · portal do parceiro');
    expect(html).not.toContain('Novo lançamento');
    expect(html).toContain("lancamentoValorClass(lancamento)");
  });

  it('mantém os filtros como estado local de apresentação', () => {
    expect(state).toContain("unidadeStockFiltro: 'todos'");
    expect(state).toContain("unidadeLancamentoFiltro: 'todos'");
    expect(kpis).toContain('unidadeEstoqueFiltrado(');
    expect(kpis).toContain('unidadeLancamentosFiltrados(');
  });
});
