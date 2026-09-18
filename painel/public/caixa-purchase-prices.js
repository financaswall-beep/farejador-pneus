(function () {
  'use strict';
  const P = window.Caixa.purchases, U = window.PurchasePriceUtils;
  const X = P.prices = { rows: [], groups: [], selected: null, supplier: null, request: 0, loading: false, failed: false };
  X.id = function (name) { return P.id('prices-' + name); };
  X.vehicle = function (type) { return type === 'car' ? 'Carro' : type === 'motorcycle' ? 'Moto' : 'Tipo não definido'; };
  X.reset = function () {
    X.request++; X.rows = []; X.groups = []; X.selected = null; X.supplier = null; X.loading = false; X.failed = false;
    X.to = P.today(); X.from = window.FarejadorTime.addDays(X.to, -89);
    ['cards', 'suppliers', 'history', 'chart', 'legend', 'variant'].forEach(function (name) { X.id(name).replaceChildren(); });
    ['best', 'total', 'difference', 'supplier-label', 'suppliers-count', 'point', 'count'].forEach(function (name) { X.id(name).textContent = ''; });
    X.id('use').disabled = true;
    X.id('search').value = ''; X.id('brand').replaceChildren(new Option('Todas as marcas', '')); X.id('condition').value = '';
    X.id('quantity').value = 10; X.id('detail').hidden = true; X.id('period').hidden = true;
    X.id('period-toggle').setAttribute('aria-expanded', 'false'); X.id('list').hidden = false;
  };
  X.group = function () { return X.groups.find(function (group) { return group.variant_key === X.selected; }) || null; };
  X.show = function (key) {
    X.selected = key; const detail = !!X.group();
    X.id('list').hidden = detail; X.id('list-heading').hidden = detail;
    X.id('detail').hidden = !detail; X.id('detail-heading').hidden = !detail;
    if (detail) X.renderDetail(); else X.renderList();
  };
  X.renderList = function () {
    const visible = U.filter(X.groups, { query: X.id('search').value, brand: X.id('brand').value, condition: X.id('condition').value });
    X.id('count').textContent = visible.length + (visible.length === 1 ? ' variante encontrada' : ' variantes encontradas');
    const host = X.id('cards'); host.replaceChildren();
    visible.forEach(function (group) {
      const best = group.suppliers[0];
      const button = P.button('', function () { X.supplier = null; X.show(group.variant_key); }, 'pp-variant-card');
      const description = P.el('span', 'pp-variant-description');
      description.append(P.el('strong', '', group.measure), P.el('span', 'pc-muted', group.brand + ' · ' + P.condition(group.tire_condition)),
        P.badge(X.vehicle(group.vehicle_type), group.vehicle_type === 'car' ? 'blue' : 'green'),
        P.el('small', 'pc-muted', group.suppliers.length + (group.suppliers.length === 1 ? ' fornecedor' : ' fornecedores')));
      const value = P.el('span', 'pp-variant-cost'); value.append(P.el('strong', '', P.money(best.avg_cost)),
        P.el('small', 'pc-muted', group.suppliers.length > 1 ? 'menor custo médio / un.' : 'custo médio / un.'));
      if (group.suppliers.length === 1) value.append(P.badge('Sem comparação', 'gray'));
      button.append(P.tire(group), description, value, P.el('span', 'pp-chevron', '›'));
      host.append(button);
    });
    if (!visible.length) host.append(P.el('p', 'pc-empty', 'Nenhuma compra recebida encontrada para estes filtros.'));
  };
  X.load = async function () {
    const request = ++X.request; const selected = X.selected;
    X.loading = true; X.failed = false; X.rows = []; X.groups = []; X.show(null);
    X.id('cards').replaceChildren(P.el('p', 'pc-empty', 'Carregando custos das compras recebidas…'));
    X.id('count').textContent = ''; X.id('limit-note').hidden = true;
    X.id('period-label').textContent = P.day(X.from) + ' — ' + P.day(X.to);
    try {
      const data = await P.request('/precos?' + new URLSearchParams({ from: X.from, to: X.to }));
      if (request !== X.request) return;
      if (!Array.isArray(data.rows)) throw new Error('invalid_response');
      X.rows = data.rows; X.groups = U.groups(data.rows); X.loading = false;
      const brand = X.id('brand').value;
      X.id('brand').replaceChildren(new Option('Todas as marcas', ''));
      [...new Set(X.groups.map(function (group) { return group.brand; }))].sort().forEach(function (name) { X.id('brand').append(new Option(name, name)); });
      X.id('brand').value = [...X.id('brand').options].some(function (option) { return option.value === brand; }) ? brand : '';
      const notes = [];
      if (data.rows.some(function (row) { return row.comparison_truncated; })) notes.push('Exibindo até 1.000 referências. Reduza o período para detalhar.');
      if (data.rows.some(function (row) { return row.history_truncated; })) notes.push('Gráfico limitado às 5.000 compras mais recentes. As médias consideram todo o período.');
      X.id('limit-note').textContent = notes.join(' '); X.id('limit-note').hidden = !notes.length;
      X.show(selected);
    } catch (error) {
      if (request !== X.request || error.message === 'invalid_session') return;
      X.loading = false; X.failed = true; X.id('cards').replaceChildren(P.el('p', 'pc-empty', 'Não foi possível carregar a comparação.'), P.button('Tentar novamente', X.load));
    }
  };
  X.id('back').addEventListener('click', function () { X.show(null); });
  ['search', 'brand', 'condition'].forEach(function (name) {
    X.id(name).addEventListener(name === 'search' ? 'input' : 'change', function () { if (!X.loading && !X.failed) X.renderList(); });
  });
  X.id('period-toggle').addEventListener('click', function () {
    X.id('period').hidden = !X.id('period').hidden; this.setAttribute('aria-expanded', String(!X.id('period').hidden));
    X.id('from').value = X.from; X.id('to').value = X.to;
    X.id('from').max = P.today(); X.id('to').max = P.today(); X.id('period-error').hidden = true;
  });
  X.id('period').addEventListener('submit', function (event) {
    event.preventDefault(); const from = X.id('from').value, to = X.id('to').value;
    if (!from || !to || from > to || to > P.today() || Date.parse(to) - Date.parse(from) > 365 * 86400000) {
      X.id('period-error').textContent = 'Escolha um período de até 366 dias, sem datas futuras, com início anterior ao fim.';
      X.id('period-error').hidden = false; return;
    }
    X.from = from; X.to = to; X.id('period').hidden = true; X.id('period-toggle').setAttribute('aria-expanded', 'false'); void X.load();
  });
  X.reset();
}());
