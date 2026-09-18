(function () {
  'use strict';
  const P = window.Caixa.purchases, X = P.prices, U = window.PurchasePriceUtils;
  const percent = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });
  function svgNode(tag, attrs, text) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.entries(attrs || {}).forEach(function (entry) { node.setAttribute(entry[0], String(entry[1])); });
    if (text != null) node.textContent = text; return node;
  }
  function pointText(point) { return point.supplier_name + ' · Compra em ' + P.date(point.date) + ' · ' + P.money(point.cost) + ' / un. · ' + point.quantity + ' pneus'; }
  function renderChart(group) {
    const chart = U.chart(group, function (date) { return P.date(date).slice(0, 5); }, 420, 220);
    const host = X.id('chart'); host.replaceChildren(); X.id('legend').replaceChildren();
    X.id('point').textContent = 'Toque em um ponto para ver a compra.';
    if (chart.empty) { host.append(P.el('p', 'pc-empty', 'Nenhuma compra individual disponível neste período.')); return; }
    const svg = svgNode('svg', { viewBox: '0 0 420 220', role: 'group', 'aria-label': 'Histórico do custo por fornecedor, sem frete e desconto' });
    chart.ticks.forEach(function (tick) {
      svg.append(svgNode('line', { x1: chart.left, x2: chart.right, y1: tick.y, y2: tick.y, stroke: '#e7ebef' }),
        svgNode('text', { x: chart.left - 7, y: tick.y + 4, 'text-anchor': 'end', fill: '#687487', 'font-size': 12 }, percent.format(tick.value)));
    });
    chart.labels.forEach(function (label) {
      svg.append(svgNode('text', { x: label.x, y: chart.bottom + 25, 'text-anchor': label.x === chart.left ? 'start' : label.x === chart.right ? 'end' : 'middle', fill: '#687487', 'font-size': 12 }, label.value));
    });
    const totalPoints = chart.series.reduce(function (sum, series) { return sum + series.points.length; }, 0);
    chart.series.forEach(function (series) {
      svg.append(svgNode('path', { d: series.path, stroke: series.color, fill: 'none', 'stroke-width': 2.5 }));
      series.points.forEach(function (point) {
        const circle = svgNode('circle', { cx: point.x, cy: point.y, r: 5, fill: series.color }); svg.append(circle);
        const hit = svgNode('circle', { cx: point.x, cy: point.y, r: 12, fill: 'transparent', tabindex: 0, role: 'button', 'aria-label': pointText(point) });
        function show() { X.id('point').textContent = pointText(point); }
        hit.addEventListener('click', show); hit.addEventListener('focus', show); hit.addEventListener('mouseenter', show);
        hit.addEventListener('keydown', function (event) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); show(); } });
        hit.append(svgNode('title', {}, pointText(point))); svg.append(hit);
        if (totalPoints <= 12) svg.append(svgNode('text', { x: point.x, y: point.y - 10, 'text-anchor': point.x === chart.left ? 'start' : point.x === chart.right ? 'end' : 'middle', fill: series.color, 'font-size': 12, 'pointer-events': 'none' }, percent.format(point.cost)));
      });
      const legend = P.el('span'); const dot = P.el('i'); dot.style.backgroundColor = series.color;
      legend.append(dot, document.createTextNode(series.supplier_name)); X.id('legend').append(legend);
    });
    host.append(svg);
  }
  X.simulate = function () {
    const group = X.group(); if (!group) return;
    const valid = X.id('quantity').checkValidity();
    const cards = U.cards(X.groups, X.selected, X.id('quantity').value, X.supplier);
    X.id('total').textContent = valid ? P.money(cards.total) : '—';
    X.id('difference').textContent = valid && cards.alternative ? P.money(Math.abs(cards.savings)) : 'Sem comparação';
    X.id('difference-label').textContent = cards.savings < 0 ? 'A mais vs. menor média' : 'Diferença para a 2ª opção';
    X.id('supplier-label').textContent = 'Referência: ' + cards.best.supplier_name;
    X.id('use').disabled = !valid || !!cards.best.supplier_archived || X.loading || !!P.state.pending || P.state.busy;
    X.id('use-note').textContent = cards.best.supplier_archived ? 'Fornecedor arquivado. Selecione um fornecedor ativo.'
      : P.state.pending ? 'Retome a confirmação pendente em Nova compra antes de continuar.' : 'Referência histórica, sem frete e desconto. Confirme o preço com o fornecedor.';
  };
  X.renderDetail = function () {
    const group = X.group(); if (!group) return;
    if (!group.suppliers.some(function (row) { return row.supplier_id === X.supplier; })) X.supplier = group.suppliers[0].supplier_id;
    const title = X.id('variant'); title.replaceChildren();
    const description = P.el('div'); description.append(P.el('h3', '', group.measure), P.el('p', 'pc-muted', group.brand + ' · ' + P.condition(group.tire_condition) + ' · ' + X.vehicle(group.vehicle_type)));
    title.append(P.tire(group), description);
    X.id('best').textContent = P.money(group.suppliers[0].avg_cost); X.id('suppliers-count').textContent = group.suppliers.length;
    X.id('suppliers').replaceChildren();
    group.suppliers.forEach(function (row) {
      const button = P.button('', function () { X.supplier = row.supplier_id; X.renderDetail(); }, 'pp-supplier-card');
      button.classList.toggle('is-selected', row.supplier_id === X.supplier); button.setAttribute('aria-pressed', String(row.supplier_id === X.supplier));
      const left = P.el('span', 'pp-supplier-name'); left.append(P.el('strong', '', row.supplier_name));
      if (row.cheapest) left.append(P.badge('Menor média', 'green'));
      if (row.supplier_archived) left.append(P.badge('Arquivado', 'gray'));
      left.append(P.el('small', 'pc-muted', row.qty_total + ' pneus · ' + (row.last_received_at ? 'Recebido em ' + P.date(row.last_received_at) : 'Compra em ' + P.date(row.last_purchased_at))));
      const right = P.el('span', 'pp-supplier-cost'); right.append(P.el('strong', '', P.money(row.avg_cost) + ' / un.'));
      if (!row.cheapest) right.append(P.el('small', 'pc-muted', row.diff_pct == null ? 'Referência mínima: R$ 0,00' : '+' + percent.format(row.diff_pct) + '% sobre a menor média'));
      button.append(left, right, P.el('span', 'pp-chevron', '›')); X.id('suppliers').append(button);
    });
    renderChart(group);
    const selected = group.suppliers.find(function (row) { return row.supplier_id === X.supplier; });
    const history = X.id('history'); history.replaceChildren();
    const rows = [...(selected.history || [])].filter(function (row) { return Number(row.quantity) > 0; }).sort(function (a, b) { return new Date(b.purchased_at) - new Date(a.purchased_at); });
    rows.forEach(function (row) {
      const line = P.el('div', 'pc-review-line'); const label = P.el('span', '', 'Compra em ' + P.date(row.purchased_at));
      label.append(P.el('small', 'pc-muted', row.quantity + ' pneus · #' + String(row.purchase_id).slice(0, 8)));
      line.append(label, P.el('strong', '', P.money(row.unit_cost) + ' / un.')); history.append(line);
    });
    if (!rows.length) history.append(P.el('p', 'pc-muted', 'Histórico individual indisponível neste recorte.'));
    X.simulate();
  };
  X.id('quantity').addEventListener('input', X.simulate);
  ['minus', 'plus'].forEach(function (name) {
    X.id(name).addEventListener('click', function () {
      X.id('quantity').value = Math.min(100000, Math.max(1, Math.round(Number(X.id('quantity').value) || 1) + (name === 'plus' ? 1 : -1))); X.simulate();
    });
  });
  X.id('use').addEventListener('click', async function () {
    if (!X.group() || !X.id('quantity').reportValidity()) return;
    const cards = U.cards(X.groups, X.selected, X.id('quantity').value, X.supplier);
    X.id('use').disabled = true;
    try { await P.startFromPrice(cards.best, cards.quantity); }
    catch (error) { if (error.message !== 'invalid_session') P.notice('Não foi possível preparar a compra. Atualize a comparação e tente novamente.'); }
    finally { X.simulate(); }
  });
}());
