import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Estoque — lista com painel da medida', () => {
  const html = readFileSync(resolve('painel/public/index.html'), 'utf8');
  const galpao = readFileSync(resolve('painel/public/app.galpao.js'), 'utf8');
  const atacado = readFileSync(resolve('painel/public/app.atacado.js'), 'utf8');
  const stockStart = html.indexOf('<div x-show="currentPage === \'estoque\'"');
  const stockEnd = html.indexOf('<div x-show="currentPage === \'logistica\'"', stockStart);
  const stockHtml = html.slice(stockStart, stockEnd);

  it('mantém os quatro indicadores derivados da mesma lista oficial', () => {
    expect(stockHtml).toContain('aria-label="Resumo do estoque"');
    expect(stockHtml).toContain('Pneus no galpão');
    expect(stockHtml).toContain('Capital em estoque');
    expect(stockHtml).toContain('Para repor');
    expect(stockHtml).toContain('Zeradas');
    expect(stockHtml).toContain('stockResumo().pneus');
    expect(stockHtml).toContain('stockResumo().capital');
    expect(stockHtml).toContain('stockResumo().repor');
    expect(stockHtml).toContain('stockResumo().zeradas');
  });

  it('usa lista mestre e painel de detalhe sem criar paginação ou mapa paralelos', () => {
    expect(stockHtml).toContain('id="estoque-lista-heading"');
    expect(stockHtml).toContain('Painel da medida');
    expect(stockHtml).toContain('selectedMeasure');
    expect(stockHtml).toContain('visibleRows()');
    expect(stockHtml).toContain('get selectedRow()');
    expect(stockHtml).toContain('selectRow(row)');
    expect(stockHtml).toContain('Medida');
    expect(stockHtml).toContain('Saldo');
    expect(stockHtml).toContain('Mínimo');
    expect(stockHtml).toContain('Custo médio');
    expect(stockHtml).toContain('Capital');
    expect(stockHtml).toContain('Status');
    expect(stockHtml.match(/\/admin\/painel\/assets\/estoque-hero\.webp\?preview=tire/g)).toHaveLength(2);
    expect(stockHtml).not.toContain('Mapa | Lista');
    expect(stockHtml).not.toContain('Criar compra');
    expect(stockHtml).not.toContain('pagination');
  });

  it('reutiliza as cinco ações auditadas da medida selecionada', () => {
    expect(stockHtml).toContain('Registrar entrada');
    expect(stockHtml).toContain('Ajustar saldo e custo');
    expect(stockHtml).toContain('Baixa manual');
    expect(stockHtml).toContain('Ver histórico');
    expect(stockHtml).toContain('Remover medida');
    expect(stockHtml).toContain("stockOperacao = 'entrada'");
    expect(stockHtml).toContain("stockOperacao = 'ajuste'");
    expect(stockHtml).toContain('stockBaixaOpen(selectedRow)');
    expect(stockHtml).toContain('filmeDaMedida(selectedRow.measure)');
    expect(stockHtml).toContain('stockRemove(selectedRow.measure)');
    expect(stockHtml).toContain('Entrada recalcula o custo médio ponderado');
  });

  it('preserva filtros, subabas e contratos existentes do galpão', () => {
    for (const label of ['Visão geral', 'Movimentações', 'Reposição', 'Custos', 'Conciliação']) {
      expect(stockHtml).toContain(label);
    }
    for (const filter of ['todos', 'em_dia', 'repor', 'zerados']) {
      expect(stockHtml).toContain(`stockFiltro = '${filter}'`);
    }
    expect(galpao).toContain("this.apiPost('/admin/api/wholesale/stock/entry'");
    expect(galpao).toContain("this.apiPost('/admin/api/wholesale/stock/baixa'");
    expect(galpao).toContain("this.apiPost('/admin/api/wholesale/stock/remove'");
    expect(galpao).toContain("this.apiGet('/admin/api/wholesale/stock/movimentos'");
    expect(galpao).toContain("this.apiGet('/admin/api/wholesale/stock/reconciliation'");
  });

  it('implementa a fila de reposição sobre o estoque oficial e abre o fluxo auditado de Compras', () => {
    expect(stockHtml).toContain('id="fila-reposicao"');
    expect(stockHtml).toContain('Fila inteligente de reposição');
    expect(stockHtml).toContain('Plano de compra');
    expect(stockHtml).toContain('Por que repor agora?');
    expect(stockHtml).toContain('Adicionar à compra');
    expect(stockHtml).toContain('Criar nova compra');
    expect(stockHtml).toContain('repoRowsView()');
    expect(stockHtml).toContain('repoPlanoResumo()');
    expect(stockHtml).toContain('repoAbrirCompra(repoPlano())');
    expect(stockHtml).toContain('/admin/painel/assets/estoque-hero.webp?preview=tire');
    expect(stockHtml).toContain('loading="lazy"');
    expect(stockHtml).toContain("stockTab = 'reposicao'; loadGalpaoFilme()");
    expect(stockHtml).toContain("const fontesDeVenda = new Set(['venda_atacado', 'varejo'])");
    expect(stockHtml).toContain('repoSugestao(row)');
    expect(stockHtml).toContain("this.currentPage = 'compras'");
    expect(stockHtml).toContain("this.comprasOpenTab('nova')");
    expect(stockHtml).toContain("receipt_status: 'pending'");
    expect(galpao).not.toContain("this.apiPost('/admin/api/wholesale/replenishment'");
  });

  it('transforma Custos em leitura financeira local sem criar uma nova fonte', () => {
    expect(stockHtml).toContain('id="capital-medida-heading"');
    expect(stockHtml).toContain('Capital por medida');
    expect(stockHtml).toContain('Leitura dos custos');
    expect(stockHtml).toContain('Custo médio ponderado');
    expect(stockHtml).toContain('Concentração no Top 3');
    expect(stockHtml).toContain('id="custos-medida-heading"');
    expect(stockHtml).toContain('Custos por medida');
    expect(stockHtml).toContain('Como este valor é calculado');
    expect(stockHtml).toContain('Mesma conta usada no Financeiro');
    expect(stockHtml).toContain('commerce.wholesale_stock');
    expect(stockHtml).toContain('custoCapital(row)');
    expect(stockHtml).toContain('custoMediaPonderada()');
    expect(stockHtml).toContain('custoTop3Percentual()');
    expect(stockHtml).toContain("custoOrdem: 'capital'");
    expect(stockHtml).toContain("stockTab = 'visao'; stockEdit(row); stockOperacao = 'ajuste'");
    expect(galpao).not.toContain("this.apiGet('/admin/api/wholesale/stock/costs'");
  });

  it('aplica a paleta verde sem tokens laranja ou rosa dentro da tela', () => {
    expect(stockHtml).toContain('from-emerald-950');
    expect(stockHtml).toContain('bg-emerald-700');
    expect(stockHtml).toContain('bg-emerald-50');
    expect(stockHtml).not.toMatch(/\b(?:brand|amber|rose)-/);
  });

  it('isola os dados demonstrativos exclusivamente na URL de preview', () => {
    expect(atacado).toContain('mock=1');
    expect(atacado).toContain('window.PAINEL_STOCK_PREVIEW');
    expect(atacado).toContain("measure: '215/75 R17.5'");
    expect(atacado).toContain("measure: '195/60 R15'");
    expect(atacado).toContain('quantity_divergent');
    expect(atacado).toContain('window.PAINEL_STOCK_PREVIEW?.enabled()');
    expect(galpao).toContain('window.PAINEL_STOCK_PREVIEW?.enabled()');
    expect(html).toContain("'prévia mockada' : 'dados reais'");
  });

  it('transforma o filme oficial em linha do tempo e indicadores locais', () => {
    expect(stockHtml).toContain('id="galpao-filme"');
    expect(stockHtml).toContain("movFiltro: 'todos'");
    expect(stockHtml).toContain('movRows()');
    expect(stockHtml).toContain('movPageSize: 25');
    expect(stockHtml).toContain('movPagedRows()');
    expect(stockHtml).toContain('movTotalPages()');
    expect(stockHtml).toContain('aria-label="Paginação das movimentações"');
    expect(stockHtml).toContain('Página anterior');
    expect(stockHtml).toContain('Próxima página');
    expect(stockHtml).toContain('galpaoFilme.rows.filter');
    expect(stockHtml).toContain('movGroups()');
    expect(stockHtml).toContain('movResumo()');
    expect(stockHtml).toContain('movRanking()');
    expect(stockHtml).toContain('movTrendPoints()');
    expect(stockHtml).toContain('Tudo que entrou, saiu ou foi ajustado · até 50 registros oficiais');
    expect(stockHtml).toContain('Resumo do período');
    expect(stockHtml).toContain('Medidas mais movimentadas');
    expect(stockHtml).toContain('Rastreabilidade preservada');
    expect(stockHtml).toContain('Entradas');
    expect(stockHtml).toContain('Saídas');
    expect(stockHtml).toContain('Ajustes');
  });
});
