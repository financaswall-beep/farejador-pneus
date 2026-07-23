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
  vm.runInNewContext(
    readFileSync(resolve('painel/public/app.charts.rede.js'), 'utf8'),
    sandbox,
  );
  return {
    ...sandbox.window.PAINEL_MODULES.redeKpis(),
    ...sandbox.window.PAINEL_MODULES.chartsRede(),
  };
}

describe('Rede — apresentação e contratos auditados', () => {
  const html = readFileSync(resolve('painel/public/index.html'), 'utf8');
  const state = readFileSync(resolve('painel/public/app.js'), 'utf8');
  const nav = readFileSync(resolve('painel/public/app.nav.js'), 'utf8');
  const kpis = readFileSync(resolve('painel/public/app.unidade.kpis.js'), 'utf8');
  const redeKpis = readFileSync(resolve('painel/public/app.rede.kpis.js'), 'utf8');
  const redeApply = readFileSync(resolve('painel/public/app.rede.apply.js'), 'utf8');
  const chartsRede = readFileSync(resolve('painel/public/app.charts.rede.js'), 'utf8');
  const chartsSaude = readFileSync(resolve('painel/public/app.charts.saude.js'), 'utf8');

  it('serve a imagem padrão da Rede e expõe as três visões sem duplicar o período', () => {
    const staticRoutes = readFileSync(resolve('src/admin/painel/route-static.ts'), 'utf8');
    const banner = statSync(resolve('painel/public/assets/rede-hero-visao-v3.webp'));

    expect(html).toContain('/admin/painel/assets/rede-hero-visao-v3.webp?v=20260723-rede-visao2');
    expect(html).not.toContain('/admin/painel/assets/rede-hero.png');
    expect(html).toContain('Rede de parceiros');
    expect(html).toContain('Operação consolidada das unidades credenciadas');
    expect(html).toContain("setRedeSection('visao')");
    expect(html).toContain("setRedeSection('operacao')");
    expect(html).toContain("setRedeSection('parceiros')");
    expect(state).toContain("redeSection: 'visao'");
    expect(nav).toContain('setRedeSection(section)');
    expect(staticRoutes).toContain("fastify.get('/admin/painel/assets/rede-hero-visao-v3.webp'");
    expect(staticRoutes).toContain("'assets/rede-hero-visao-v3.webp', 'image/webp'");
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

  it('usa o menu verde como padrão e preserva a barra superior na Rede', () => {
    expect(html).toContain('<aside class="w-56 bg-gradient-to-b from-emerald-950 via-emerald-900 to-emerald-950');
    expect(html).toContain('<div class="h-28 flex items-center gap-3 px-6 border-b border-emerald-800/70">');
    expect(html).toContain("currentPage === item.id");
    expect(html).toContain('Fase 2 · próximos');
    expect(html).toContain('Em operação');
    expect(html).toContain('Configurações');
    expect(html).toContain(":class=\"mockTopbar ? 'bg-gray-50 px-3 pt-3 pb-2' : 'bg-white/80 backdrop-blur-md border-b border-gray-200'\"");
    expect(html).toContain('class="sticky top-0 z-30"');
    expect(html).not.toContain('<div x-show="currentPage !== \'rede\'" class="sticky top-0');
    expect(html).toContain('aria-label="Buscar no painel"');
    expect(html).toContain('aria-label="Abrir notificações"');
    expect(html).toContain('@click="logoutAdmin()"');
    expect(html).toContain('sm:grid-cols-2 xl:grid-cols-6');
    expect(html).toContain('text-base 2xl:text-xl');
  });

  it('ativa a central de comando somente na prévia mockada sem trocar as ações existentes', () => {
    expect(html).toContain("new URLSearchParams(window.location.search).get('mock') === '1'");
    expect(html).toContain('Central de rede');
    expect(html).toContain('Buscar ou executar um comando...');
    expect(html).toContain('@click="openWalkinModal()"');
    expect(html).toContain('@click="openPartnerModal()"');
    expect(html).toContain('@click="openApplications()"');
    expect(html).toContain('x-show="!mockTopbar" aria-label="Buscar no painel"');
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

  it('reproduz a visão executiva proposta sem criar uma segunda fonte de dados', () => {
    expect(redeApply).toContain("{ label: 'Origem 2W'");
    expect(redeKpis).toContain('redeTopUnidades()');
    expect(redeKpis).toContain('redeParticipacaoVendas(parceiro)');
    expect(chartsRede).toContain('redeExecutiveSalesSeries()');
    expect(chartsRede).toContain('redeResultadosUnidades()');
    expect(chartsRede).toContain('this.redeExecutiveSalesSeries()');
    expect(chartsRede).not.toContain("label: 'Pedidos reais'");
    expect(html).toContain('Resumo central');
    expect(html).toContain('Top 3 unidades por vendas');
    expect(html).toContain('x-text="index + 1"');
    expect(html).toContain('x-text="redeParticipacaoVendas(parceiro)"');
    expect(html).toContain('x-text="redeTotalVendas()"');
    expect(html).toContain('x-text="redeTotalPedidos()"');
    expect(html).toContain('x-text="formatCurrency(redeTicketMedio())"');
  });

  it('sinaliza custo pendente sem fabricar resultado e concilia a origem das vendas', () => {
    expect(chartsRede).toContain('.filter((parceiro) => !parceiro.custoPendente');
    expect(redeKpis).toContain('unidadesComCustoPendente()');
    expect(html).toContain('redeResultadosUnidades()');
    expect(html).toContain('redeResultadoBarWidth(parceiro)');
    expect(html).toContain('Custo pendente</span>');
    expect(redeKpis).toContain('redeOrigemTotal()');
    expect(redeKpis).toContain('redeOrigemPercent(valor)');
    expect(html).toContain('formatCurrency(redeOrigemTotal())');
    expect(html).toContain('redeOrigemPercent(redeTotal2w())');
    expect(html).toContain('redeOrigemPercent(redeTotalPorta())');
    expect(html).toContain('Visão consolidada por canal');
    expect(html).toContain('2 canais');
    expect(html).toContain("redeTotal2w() >= redeTotalPorta() ? '2W' : 'Porta'");
    expect(html).toContain('xl:grid-cols-[minmax(0,1.3fr)_minmax(420px,0.92fr)]');
    expect(html).toContain('Fonte: <strong class="text-slate-700">vendas realizadas');
    expect(chartsSaude).toContain('createLinearGradient');
    expect(chartsSaude).toContain('legend: { display: false }');
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

  it('mantém a série completa do período e ordena resultados sem inventar custo', () => {
    const module = redeKpisModule();
    const parceirosRede = [
      { id: 'a', vendasValor: 300, serieVendas: [10, 20, 30], custoPendente: false, lucroEstimado: 90 },
      { id: 'b', vendasValor: 250, serieVendas: [5, 15], custoPendente: true, lucroEstimado: null },
      { id: 'c', vendasValor: 100, serieVendas: [2, 3, 4], custoPendente: false, lucroEstimado: -30 },
    ];
    const context = {
      parceirosRede,
      redeExecutiveSalesSeries: module.redeExecutiveSalesSeries,
      redeResultadosUnidades: module.redeResultadosUnidades,
    };

    expect(Array.from(module.redeExecutiveSalesSeries.call(context))).toEqual([12, 28, 49]);
    expect(Array.from(module.redeResultadosUnidades.call(context), (row: { id: string }) => row.id))
      .toEqual(['a', 'b', 'c']);
    expect(module.redeResultadoBarWidth.call(context, parceirosRede[0])).toBe(100);
    expect(module.redeResultadoBarWidth.call(context, parceirosRede[1])).toBe(0);
    expect(module.redeResultadoBarWidth.call(context, parceirosRede[2])).toBe(33);
  });
});
