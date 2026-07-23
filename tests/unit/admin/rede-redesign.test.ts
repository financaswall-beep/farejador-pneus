import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

function redeKpisModule() {
  const sandbox = { window: { PAINEL_MODULES: {} } };
  vm.runInNewContext(
    readFileSync(resolve('painel/public/app.rede.kpis.js'), 'utf8'),
    sandbox,
  );
  return sandbox.window.PAINEL_MODULES.redeKpis();
}

describe('Rede — apresentação e contratos auditados', () => {
  const html = readFileSync(resolve('painel/public/index.html'), 'utf8');
  const state = readFileSync(resolve('painel/public/app.js'), 'utf8');
  const nav = readFileSync(resolve('painel/public/app.nav.js'), 'utf8');
  const kpis = readFileSync(resolve('painel/public/app.unidade.kpis.js'), 'utf8');
  const redeKpis = readFileSync(resolve('painel/public/app.rede.kpis.js'), 'utf8');
  const redeApply = readFileSync(resolve('painel/public/app.rede.apply.js'), 'utf8');
  const chartsRede = readFileSync(resolve('painel/public/app.charts.rede.js'), 'utf8');

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

  it('completa a visão executiva sem repetir o resumo central', () => {
    expect(redeApply).toContain("{ label: 'Origem 2W'");
    expect(redeKpis).toContain('redeTopUnidades()');
    expect(redeKpis).toContain('redeParticipacaoVendas(parceiro)');
    expect(html).toContain('Top 3 unidades por vendas realizadas');
    expect(html).toContain('x-text="index + 1"');
    expect(html).toContain('x-text="redeParticipacaoVendas(parceiro)"');
    expect(html).not.toContain('Resumo central');
  });

  it('sinaliza custo pendente sem fabricar resultado e concilia a origem das vendas', () => {
    expect(chartsRede).toContain('.filter((parceiro) => !parceiro.custoPendente');
    expect(redeKpis).toContain('unidadesComCustoPendente()');
    expect(html).toContain('custos pendentes ficam sinalizados sem cálculo artificial');
    expect(html).toContain('Custo pendente</span>');
    expect(redeKpis).toContain('redeOrigemTotal()');
    expect(redeKpis).toContain('redeOrigemPercent(valor)');
    expect(html).toContain('formatCurrency(redeOrigemTotal())');
    expect(html).toContain('redeOrigemPercent(redeTotal2w())');
    expect(html).toContain('redeOrigemPercent(redeTotalPorta())');
  });

  it('calcula ranking, participação e origem usando os totais conciliados', () => {
    const module = redeKpisModule();
    const parceirosRede = [
      { id: 'a', vendasValor: 300, custoPendente: false },
      { id: 'b', vendasValor: 100, custoPendente: true, custoPendenteReceita: 100 },
      { id: 'c', vendasValor: 200, custoPendente: false },
      { id: 'd', vendasValor: 50, custoPendente: true, custoPendenteReceita: 50 },
    ];

    expect(Array.from(module.redeTopUnidades.call({ parceirosRede }), (row: { id: string }) => row.id))
      .toEqual(['a', 'c', 'b']);
    expect(module.redeParticipacaoVendas.call({
      redeTotalVendasValor: () => 600,
    }, parceirosRede[0])).toBe('50,0%');
    expect(module.redeOrigemPercent.call({ redeOrigemTotal: () => 400 }, 250)).toBe(63);
    expect(Array.from(module.unidadesComCustoPendente.call({ parceirosRede }), (row: { id: string }) => row.id))
      .toEqual(['b', 'd']);
  });
});
