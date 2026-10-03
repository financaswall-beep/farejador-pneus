import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Estoque — lista com painel da medida', () => {
  const html = readFileSync(resolve('painel/public/index.html'), 'utf8');
  const galpao = [
    readFileSync(resolve('painel/public/app.galpao.contagem.js'), 'utf8'),
    readFileSync(resolve('painel/public/app.galpao.multibrand.js'), 'utf8'),
    readFileSync(resolve('painel/public/app.galpao.js'), 'utf8'),
  ].join('\n');
  const atacado = readFileSync(resolve('painel/public/app.atacado.js'), 'utf8');
  const stockStart = html.indexOf('<template x-if="currentPage === \'estoque\' && isMatrixPanel()');
  const stockEnd = html.indexOf('<div x-show="currentPage === \'logistica\' && isPartnerPanel()"', stockStart);
  const stockHtml = html.slice(stockStart, stockEnd);
  it('localiza a tela de estoque completa', () => {
    expect(stockStart).toBeGreaterThan(-1);
    expect(stockEnd).toBeGreaterThan(stockStart);
  });

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
    expect(stockHtml).toContain('selectedVariant');
    expect(stockHtml).toContain('visibleRows()');
    expect(stockHtml).toContain('get selectedRow()');
    expect(stockHtml).toContain('selectRow(row)');
    expect(stockHtml).toContain('Medida');
    expect(stockHtml).toContain('Saldo');
    expect(stockHtml).toContain('Mínimo');
    expect(stockHtml).toContain('Custo médio');
    expect(stockHtml).toContain('Capital');
    expect(stockHtml).toContain('Status');
    expect(stockHtml.match(/\/admin\/painel\/assets\/catalog-tire\.webp\?v=20260729-catalogo1/g)).toHaveLength(3);
    expect(stockHtml.match(/\/admin\/painel\/assets\/estoque-hero\.webp\?preview=tire/g)).toHaveLength(1);
    expect(stockHtml).not.toContain('Mapa | Lista');
    expect(stockHtml).not.toContain('Criar compra');
    const master = stockHtml.slice(stockHtml.indexOf('id="estoque-lista-heading"'), stockHtml.indexOf('id="galpao-filme"'));
    expect(master.length).toBeGreaterThan(0);
    expect(master).not.toContain('pagination');
  });

  it('reutiliza as ações auditadas da medida selecionada', () => {
    expect(stockHtml).toContain('Registrar entrada');
    expect(stockHtml).toContain('Ajustar saldo e custo');
    expect(stockHtml).toContain('Baixa manual');
    expect(stockHtml).toContain('Ver histórico');
    expect(stockHtml).toContain('Remover variante');
    expect(stockHtml).toContain('Corrigir condição');
    expect(stockHtml).toContain("stockOperacao = 'entrada'");
    expect(stockHtml).toContain("stockOperacao = 'ajuste'");
    expect(stockHtml).toContain('stockBaixaOpen(selectedRow)');
    expect(stockHtml).toContain('filmeDaMedida(selectedRow.measure, selectedRow.brand, selectedRow.tire_condition)');
    expect(stockHtml).toContain('stockRemove(selectedRow)');
    expect(galpao).toContain('Remover ${measure} · ${brand}? O saldo será baixado e conciliado no Financeiro.');
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
    expect(stockHtml).toContain('Marca da variante');
    expect(stockHtml).toContain('Separa saldo e custo; também aparece no Catálogo');
    expect(galpao).toContain('brand: brand || null');
    expect(stockHtml).toContain("row.brand || 'Marca não informada'");
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
    expect(stockHtml).toContain("stockTab = 'reposicao'; loadGalpaoFilme(null, null)");
    expect(galpao).toContain("const sources = new Set(['venda_atacado', 'varejo'])");
    expect(galpao).toContain('this.repoKey(movement) !== key');
    expect(galpao).toContain('brand: row.brand');
    expect(stockHtml).toContain('repoSugestao(row)');
    expect(galpao).toContain("this.currentPage = 'compras'");
    expect(galpao).toContain("this.comprasOpenTab('nova')");
    expect(galpao).toContain("receipt_status: 'pending'");
    expect(galpao).not.toContain("this.apiPost('/admin/api/wholesale/replenishment'");
  });

  it('lê os custos do motor oficial, com capital, reserva e saldo disponível separados', () => {
    const costs = readFileSync(resolve('painel/public/app.estoque.custos.js'), 'utf8');
    expect(stockHtml).toContain('id="sc-heading"');
    expect(stockHtml).toContain('id="sc-capital-heading"');
    expect(stockHtml).toContain('Onde está o capital');
    expect(stockHtml).toContain('stockCosts.data.lots');
    expect(stockHtml).toContain('scTotals.quantity_on_hand');
    expect(stockHtml).toContain('scTotals.quantity_reserved');
    expect(stockHtml).toContain('scTotals.quantity_available');
    expect(stockHtml).toContain('Como os custos são calculados');
    expect(stockHtml).toContain('scExport()');
    expect(costs).toContain('/admin/api/wholesale/stock/costs?vehicle_type=');
    expect(costs).toContain('if (request !== s.request) return');
    expect(costs).not.toContain('this.apiPost(');
  });

  it('aplica a paleta verde sem tokens laranja ou rosa dentro da tela', () => {
    expect(stockHtml).toContain('from-emerald-950');
    expect(stockHtml).toContain('bg-emerald-700');
    expect(stockHtml).toContain('bg-emerald-50');
    expect(stockHtml).not.toMatch(/\b(?:bg|text|border|from|via|to)-(?:amber|rose)-/);
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
