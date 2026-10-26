(function () {
  'use strict';
  const C = window.Caixa, P = C.Pickups;
  const paths = {
    back: 'm14 5-7 7 7 7', next: 'm9 5 7 7-7 7', refresh: 'M20 5v6h-6M4 19v-6h6M5 8a8 8 0 0 1 13-3l2 3M4 16l2 3a8 8 0 0 0 13-3',
    clock: 'M12 8v4l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
    person: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M4 21a8 8 0 0 1 16 0',
    tool: 'm14.7 6.3 3-3a5 5 0 0 1-6.4 6.4l-6.6 6.6a2.1 2.1 0 0 0 3 3l6.6-6.6a5 5 0 0 1 6.4-6.4l-3 3-3-3Z',
    check: 'm5 12 4 4L19 6', search: 'M19 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0m-2 5 5 6',
    card: 'M3 5h18v14H3zM3 10h18M7 15h4', cash: 'M2 6h20v12H2zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
    pix: 'm12 2 5 5-5 5-5-5 5-5Zm0 10 5 5-5 5-5-5 5-5ZM2 12l4-4 4 4-4 4-4-4Zm12 0 4-4 4 4-4 4-4-4Z',
    trash: 'M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7',
    whatsapp: 'M21 11.5a9 9 0 0 1-13.4 7.8L3 21l1.6-4.4A9 9 0 1 1 21 11.5ZM8 7c0 5 4 9 8 9l1-3-3-1-1 1-3-3 1-1-1-3-2 1',
    receipt: 'M5 2h14v20l-3-2-4 2-4-2-3 2V2Zm4 5h6m-6 4h6m-6 4h4',
    warning: 'm12 3 10 18H2L12 3Zm0 6v5m0 3v1', plus: 'M12 4v16M4 12h16',
  };
  function el(tag, value, className) { const n = document.createElement(tag); if (value != null) n.textContent = value; if (className) n.className = className; return n; }
  function icon(name) { return C.createSvg([{ d: paths[name] || paths.next }]); }
  function button(label, action, type, symbol) {
    const n = el('button', null, 'mp-button mp-' + (type || 'secondary')); n.type = 'button'; n.dataset.mpAction = action;
    if (symbol) n.appendChild(icon(symbol)); n.appendChild(el('span', label)); return n;
  }
  function plate(className) { return el('section', null, 'mp-plate ' + (className || '')); }
  const tires = row => (row.items || []).filter(item => !item.pickup_service_code);
  const quantity = row => tires(row).reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const order = row => row.order_number ? 'Pedido ' + row.order_number : P.orderLabel(row);
  const condition = value => ({ novo: 'Novo', meia_vida: 'Meia-vida', remold: 'Remold' })[value] || '';
  function heading(title, back) {
    const n = el('header', null, 'mp-heading');
    if (back) { const b = button('', back, 'icon', 'back'); b.setAttribute('aria-label', 'Voltar'); n.appendChild(b); }
    const h = el('h2', title); h.tabIndex = -1; n.appendChild(h); return n;
  }
  function status(row) {
    const stage = P.pickupStage(row), badge = el('span', null, 'mp-status mp-status-' + stage);
    badge.append(icon(({ waiting: 'clock', arrived: 'person', installing: 'tool', completed: 'check' })[stage]), el('span', P.stageLabel(stage))); return badge;
  }
  function identity(row, showStatus = true) {
    const n = plate('mp-identity'), avatar = el('span', (row.customer_name || 'Cliente').split(/\s+/).filter(Boolean).slice(0, 2).map(s => s[0]).join(''), 'mp-avatar');
    const copy = el('div', null, 'mp-person'); copy.append(el('h3', row.customer_name || 'Cliente não identificado'), el('p', order(row)));
    n.append(avatar, copy); if (showStatus) n.appendChild(status(row)); return n;
  }
  function picture() { const img = el('img'); img.src = '/operacao/catalog-tire.webp'; img.alt = ''; img.className = 'mp-tire'; return img; }
  function product(row, compact) {
    const list = plate('mp-products' + (compact ? ' mp-products-compact' : ''));
    tires(row).forEach(item => {
      const entry = el('div', null, 'mp-product'), copy = el('div');
      copy.append(el('strong', item.tire_size || item.product_name || 'Pneu'), el('p', [item.brand, condition(item.tire_condition)].filter(Boolean).join(' · ')),
        el('small', Number(item.quantity || 0) + (Number(item.quantity) === 1 ? ' pneu' : ' pneus') + ' × ' + P.money(item.unit_price)));
      entry.append(picture(), copy); list.appendChild(entry);
    });
    if (!tires(row).length) list.appendChild(el('p', 'Itens do pedido não informados.'));
    return list;
  }
  function totalLine(label, amount, large) {
    const n = el('p', null, large ? 'mp-total-line mp-total-large' : 'mp-total-line');
    n.append(el('span', label), el('strong', amount)); return n;
  }
  function totals(row) {
    const n = plate('mp-totals'), completed = P.pickupStage(row) === 'completed';
    const services = P.servicesCents(row) / 100, total = P.fullTotal(row);
    const products = completed ? Number(row.total_amount) - services : Number(row.total_amount);
    n.append(totalLine('Pneus', P.money(products)), totalLine('Serviços', P.money(services)), totalLine(completed ? 'Total recebido' : 'Total', P.money(total), true));
    if (!Number.isFinite(services) || !Number.isFinite(total)) n.querySelectorAll('strong').forEach(value => { value.textContent = '—'; });
    return n;
  }
  function queue(m) {
    const page = el('div', null, 'mp-page mp-queue'), top = heading('Retiradas');
    const refresh = button('', 'refresh', 'icon', 'refresh'); refresh.setAttribute('aria-label', 'Atualizar retiradas'); top.appendChild(refresh); page.appendChild(top);
    const summary = el('div', null, 'mp-kpis');
    [['waiting', 'Aguardando', 'clock'], ['arrived', 'Na loja', 'person'], ['installing', 'Instalação', 'tool']].forEach(([stage, label, symbol]) => {
      const box = plate(), copy = el('div'); copy.append(el('small', label), el('strong', m.phase === 'ready' ? String(P.state.rows.filter(row => P.pickupStage(row) === stage).length) : '—'));
      box.append(icon(symbol), copy); summary.appendChild(box);
    }); page.appendChild(summary);
    const search = el('label', null, 'mp-search'); search.appendChild(icon('search'));
    const input = el('input'); input.id = 'mp-search'; input.type = 'search'; input.placeholder = 'Cliente ou pedido'; input.maxLength = 100; input.value = P.state.search; input.setAttribute('aria-label', 'Buscar cliente ou pedido');
    search.appendChild(input); page.appendChild(search);
    const filters = el('nav', null, 'mp-filters'); filters.setAttribute('aria-label', 'Filtrar retiradas');
    [['all', 'Todos'], ['waiting', 'Aguardando'], ['arrived', 'Na loja'], ['installing', 'Instalação'], ['completed', 'Concluídas']].forEach(([value, label]) => {
      const b = button(label, 'filter'); b.id = 'mp-filter-' + value; b.dataset.filter = value; b.classList.toggle('active', value === P.state.filter); b.setAttribute('aria-pressed', String(value === P.state.filter)); filters.appendChild(b);
    }); page.appendChild(filters);
    const list = el('div', null, 'mp-list'); list.id = 'mp-list'; list.setAttribute('aria-live', 'polite'); page.appendChild(list); return page;
  }
  function list(m, host) {
    host.replaceChildren();
    if (m.phase !== 'ready') {
      host.appendChild(el('p', m.phase === 'error' ? 'Não foi possível carregar as retiradas.' : 'Carregando retiradas…', 'mp-notice'));
      if (m.phase === 'error') host.appendChild(button('Tentar novamente', 'refresh', 'primary')); return;
    }
    const query = P.state.search.trim().toLocaleLowerCase('pt-BR');
    const rows = P.state.rows.filter(row => (P.state.filter === 'all' || P.pickupStage(row) === P.state.filter)
      && [row.customer_name, row.customer_phone, order(row), P.itemsLabel(row)].join(' ').toLocaleLowerCase('pt-BR').includes(query));
    rows.forEach(row => {
      const card = plate('mp-order'), copy = el('div', null, 'mp-order-copy'), head = el('header');
      head.append(el('h3', row.customer_name || 'Cliente não identificado'), el('small', order(row)));
      copy.append(head, el('p', P.itemsLabel(row)), status(row));
      const footer = el('footer'), open = button(P.pickupStage(row) === 'waiting' ? 'Atender' : 'Abrir', 'open', P.pickupStage(row) === 'waiting' ? 'primary' : 'secondary', 'next'); open.dataset.order = row.order_id;
      footer.append(el('strong', P.money(P.fullTotal(row))), open); copy.appendChild(footer); card.append(picture(), copy); host.appendChild(card);
    });
    if (!rows.length) { const n = el('div', null, 'mp-notice'); n.append(el('strong', 'Nenhuma retirada encontrada'), el('p', query || P.state.filter !== 'all' ? 'Experimente outra busca ou filtro.' : 'Os pedidos reservados para retirada aparecerão aqui.')); host.appendChild(n); }
  }
  function arrival(row) {
    const page = el('div', null, 'mp-page'); page.append(heading('Atender retirada', 'queue'), identity(row), product(row));
    if (row.has_stock_reservation) { const n = plate('mp-reservation'); n.append(icon('check'), el('div', 'Reserva de estoque ativa')); page.appendChild(n); }
    if (row.fulfillment_not_before) page.appendChild(el('p', 'Retirada a partir de ' + C.dateTime.format(new Date(row.fulfillment_not_before)), 'mp-hint'));
    const total = plate('mp-totals'); total.appendChild(totalLine('Total dos pneus', P.money(row.total_amount), true)); page.appendChild(total);
    let phone = String(row.customer_phone || '').replace(/\D/g, ''); if (phone.length === 10 || phone.length === 11) phone = '55' + phone;
    if (phone) { const link = el('a', null, 'mp-button mp-secondary'); link.append(icon('whatsapp'), el('span', 'Falar com cliente')); link.href = 'https://wa.me/' + phone; link.target = '_blank'; link.rel = 'noopener noreferrer'; page.appendChild(link); }
    page.append(button('Cliente chegou', 'arrived', 'primary', 'person'), button('Cancelar pedido', 'cancel', 'link-danger', 'trash')); return page;
  }
  function completed(row) {
    const page = el('div', null, 'mp-page mp-completed'); page.appendChild(heading('Retirada concluída', 'queue'));
    const seal = el('div', null, 'mp-success-seal'); seal.appendChild(icon('check')); page.append(seal, identity(row, false), product(row, true), totals(row));
    const summary = page.querySelector('.mp-totals'); summary.insertBefore(totalLine('Pagamento', row.payment_method || 'Não informado'), summary.lastElementChild);
    ['Pneus entregues', 'Pagamento registrado', 'Estoque atualizado'].forEach(label => { const n = el('p', null, 'mp-success-line'); n.append(icon('check'), el('span', label)); page.appendChild(n); });
    page.appendChild(button('Voltar para retiradas', 'queue', 'primary', 'back'));
    if (C.canModule('vendas')) page.appendChild(button('Ver venda', 'receipt', 'secondary', 'receipt')); return page;
  }
  C.pickupMetalView = { el, icon, button, plate, tires, quantity, order, heading, identity, product, totalLine, totals, queue, list, arrival, completed };
}());
