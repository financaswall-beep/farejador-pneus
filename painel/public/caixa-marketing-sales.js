(function () {
  'use strict';
  const M = window.Caixa.marketing, V = M.V;
  const O = { ...window.PAINEL_MODULES.marketingOrganicSummary(), ...window.PAINEL_MODULES.marketingOrganicResults() };
  M.salesModel = O;
  M.clearSales = () => { O.moDetail = null; O.moSelected = null; O.moJourneySale = null; O.moSalesPage = 1; O.moSalesSearch = ''; };
  function context() {
    Object.assign(O, { moDetail: M.state.detail, moSelected: M.state.selected, moSummaryPeriod: M.state.window,
      moDetailLoading: M.state.detailLoading, moDetailError: M.state.detailError ? 'unavailable' : '', moSalesSearch: M.el('sales-search').value });
    O.moSalesStatus = 'completed';
  }
  function journey(sale) {
    O.moJourneySale = sale;
    const body = V.dialog('Origem da venda'); body.appendChild(V.node('p', 'Pedido ' + sale.order_number + ' · ' + V.money(sale.amount)));
    O.moSaleJourneySteps().forEach(step => {
      const item = V.node('section', null, 'mk-journey-step'); item.append(V.node('h4', step.label), V.node('small', step.time ? V.date(step.time) : 'Sem registro de horário', 'mk-muted'), V.node('p', step.text));
      const url = V.safeUrl(step.url, true); if (url) { const a = V.node('a', 'Ver na rede ↗', 'mk-link'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; item.appendChild(a); }
      body.appendChild(item);
    });
  }
  M.pages.sales = () => {
    context(); M.el('sales-post').replaceChildren(V.postContext(M.state.selected)); M.el('sales-period').value = M.state.window;
    const host = M.el('sales-list'), summary = M.el('sales-summary'), pagination = M.el('sales-pagination'); host.replaceChildren(); summary.replaceChildren(); pagination.replaceChildren();
    if (M.state.detailLoading) { V.empty(host, 'Conferindo a origem das vendas…'); return; }
    M.detailNetworks(summary);
    if (!O.moSummaryReady() || M.state.detailError) { V.empty(host, 'Ainda não foi possível confirmar os resultados comerciais deste conteúdo. Nenhuma venda será atribuída por aproximação.'); return; }
    summary.append(V.node('p', O.moSummaryRange(), 'mk-muted'), V.metric('Valor vendido', O.moSummaryNumber(O.moSummaryValue('revenue'), true), 'is-hero is-green'), V.node('p', O.moSummaryNumber(O.moSummaryValue('sales')) + ' vendas concluídas'));
    const conversion = V.node('div', null, 'mk-notice'); conversion.append(V.node('strong', O.moConversionText()), V.node('small', O.moConversion() == null ? '' : O.moConversionPercent() + ' de conversão')); summary.appendChild(conversion);
    if (!O.moSalesReady()) { V.empty(host, 'A lista de vendas vinculadas está indisponível. Atualize para conferir.'); return; }
    O.moSalesPage = Math.max(1, Math.min(O.moSalesPage, O.moSalesPages()));
    const rows = O.moSalesRows();
    if (!rows.length) V.empty(host, 'Nenhuma venda concluída encontrada para este conteúdo e período.');
    rows.forEach(sale => {
      const button = V.button('', () => journey(sale), 'mk-sale-row'), copy = V.node('span');
      copy.append(V.node('strong', 'PED-' + sale.order_number.replace(/^PED-/i, '')), V.node('small', O.moSaleDate(sale), 'mk-muted'));
      button.append(copy, V.node('b', V.money(sale.amount)), V.icon('chevron')); host.appendChild(button);
    });
    if (O.moSalesPages() > 1) {
      const prev = V.button('Anterior', () => { O.moSalesPage--; M.render(); }), next = V.button('Próxima', () => { O.moSalesPage++; M.render(); });
      V.disabled(prev, O.moSalesPage <= 1); V.disabled(next, O.moSalesPage >= O.moSalesPages());
      pagination.append(prev, V.node('span', O.moSalesPage + ' de ' + O.moSalesPages()), next);
    }
  };
  M.el('sales-period').addEventListener('change', () => { M.state.window = M.el('sales-period').value; O.moSalesPage = 1; void M.loadDetail(); });
  M.el('sales-search').addEventListener('input', () => { O.moSalesPage = 1; M.pages.sales(); });
}());
