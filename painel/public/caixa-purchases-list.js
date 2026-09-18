(function () {
  'use strict';
  const C = window.Caixa, P = C.purchases, s = P.state;
  let timer;
  P.reference = function (row) { return row.order_code || String(row.id || '').slice(0, 8); };
  P.badge = function (label, color) { return P.el('span', 'pc-badge pc-' + color, label); };
  P.statuses = function (row) {
    const line = P.el('div', 'pc-badges');
    const receipt = row.status === 'confirmed' ? ['✓ Recebida', 'green'] : row.status === 'cancelled' ? ['Cancelada', 'gray'] : ['Aguardando chegada', 'blue'];
    line.append(P.badge(receipt[0], receipt[1]));
    if (row.status !== 'cancelled') line.append(P.badge(row.payment_status === 'paid' ? '✓ Pago' : '◷ A prazo', row.payment_status === 'paid' ? 'green' : 'amber'));
    return line;
  };
  function card(row) {
    const node = P.el('article', 'pc-card pc-purchase-card');
    const heading = P.el('div', 'pc-between pc-card-heading');
    const name = P.el('div'); name.append(P.el('h3', '', row.supplier_name), P.el('p', 'pc-muted', 'Compra ' + P.reference(row) + ' · ' + P.date(row.purchased_at)));
    heading.append(name, P.el('strong', 'pc-card-amount', P.money(row.total_amount)));
    const body = P.el('div', 'pc-card-body');
    const images = P.el('div', 'pc-thumbnails');
    const items = Array.isArray(row.items) ? row.items : [];
    const lot = row.purchase_kind === 'lot';
    if (lot) images.append(P.icon('box'));
    else items.slice(0, 2).forEach(function (item) { images.append(P.tire(item)); });
    const summary = P.el('div');
    summary.append(P.el('p', 'pc-muted', row.items_count + ' pneus · ' + (lot ? 'Lote fechado' : new Set(items.map(function (i) { return i.measure; })).size + ' medidas')), P.statuses(row));
    body.append(images, summary);
    const footer = P.el('div', 'pc-card-footer');
    footer.append(P.button('Ver detalhes ›', function () { P.openDetail(row, false); }, 'pc-link'));
    if (row.status === 'pending') {
      const receive = P.button('Conferir chegada', function () { P.openDetail(row, true); }, 'pc-button pc-primary');
      receive.prepend(P.icon('box')); footer.append(receive);
    }
    node.append(heading, body);
    if (row.payment_status === 'pending' && row.due_date && row.status !== 'cancelled') {
      node.append(P.el('p', 'pc-due', 'Vencimento: ' + P.day(row.due_date)));
    }
    node.append(footer); return node;
  }
  P.load = async function () {
    const request = ++s.request;
    const query = new URLSearchParams({ period: P.id('period').value,
      status: s.tab === 'pending' ? 'pending' : P.id('status-filter').value,
      payment: P.id('payment-filter').value, search: P.id('search').value.trim(), page: s.page, page_size: 10 });
    P.id('cards').replaceChildren(P.el('p', 'pc-empty', 'Carregando compras…'));
    P.id('prev').disabled = true; P.id('next').disabled = true;
    try {
      const data = await P.request('?' + query);
      if (request !== s.request) return;
      if (!Array.isArray(data.rows) || !data.pagination) throw new Error('invalid_response');
      s.rows = data.rows || []; s.pages = data.pagination?.pages || 1;
      if (s.page > s.pages) { s.page = s.pages; return P.load(); }
      P.id('cards').replaceChildren(...s.rows.map(card));
      if (!s.rows.length) P.id('cards').append(P.el('p', 'pc-empty', 'Nenhuma compra encontrada com estes filtros.'));
      P.id('pagination').textContent = (data.pagination?.total || 0) + ' compras · Página ' + s.page + ' de ' + s.pages;
      P.id('prev').disabled = s.page <= 1; P.id('next').disabled = s.page >= s.pages;
    } catch (error) {
      if (request !== s.request || error.message === 'invalid_session') return;
      P.id('cards').replaceChildren(P.el('p', 'pc-empty', 'Não foi possível carregar as compras.'), P.button('Tentar novamente', P.load));
      P.id('pagination').textContent = '';
    }
  };
  P.summary = async function () {
    P.id('pending-count').textContent = '…'; P.id('payable').textContent = '…';
    try {
      const data = await P.request('/resumo');
      P.id('pending-count').textContent = data.pending_receipts ?? '—';
      P.id('tab-count').textContent = data.pending_receipts ?? '';
      P.id('payable').textContent = data.payable_total == null ? '—' : P.money(data.payable_total);
      P.id('summary-note').hidden = data.pending_receipts != null && data.payable_total != null;
      P.id('summary-note').textContent = 'Parte dos totais está indisponível. Toque em atualizar para tentar novamente.';
    } catch (error) {
      if (error.message === 'invalid_session') return;
      P.id('pending-count').textContent = '—'; P.id('payable').textContent = '—';
      P.id('summary-note').textContent = 'Totais indisponíveis. Toque em atualizar para tentar novamente.'; P.id('summary-note').hidden = false;
    }
  };
  function filter() { s.page = 1; void P.load(); }
  P.selectListTab = function (tab, reload = true) {
    s.tab = tab;
    ['pending', 'history', 'prices'].forEach(function (name) { P.id('tab-' + name).setAttribute('aria-selected', String(tab === name)); });
    P.id('orders-content').hidden = tab === 'prices'; P.id('prices').hidden = tab !== 'prices';
    document.getElementById('purchases-panel').classList.toggle('pc-pricing', tab === 'prices');
    P.id('status-label').hidden = tab === 'pending';
    if (reload) { if (tab === 'prices') void P.prices.load(); else filter(); }
  };
  ['pending', 'history', 'prices'].forEach(function (tab) {
    P.id('tab-' + tab).addEventListener('click', function () { P.selectListTab(tab); });
  });
  P.id('search').addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(filter, 250); });
  ['period', 'payment-filter', 'status-filter'].forEach(function (id) { P.id(id).addEventListener('change', filter); });
  P.id('clear-filters').addEventListener('click', function () {
    ['period', 'payment-filter', 'status-filter'].forEach(function (id) { P.id(id).value = 'all'; }); P.id('search').value = ''; filter();
  });
  P.id('filter-toggle').addEventListener('click', function () {
    P.id('filters').hidden = !P.id('filters').hidden; this.setAttribute('aria-expanded', String(!P.id('filters').hidden));
  });
  P.id('refresh').addEventListener('click', function () { P.selectListTab(s.tab); void P.summary(); });
  P.id('prev').addEventListener('click', function () { if (s.page > 1) { s.page--; void P.load(); } });
  P.id('next').addEventListener('click', function () { if (s.page < s.pages) { s.page++; void P.load(); } });
}());
