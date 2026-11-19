(function () {
  'use strict';
  const C = window.Caixa, P = C.Pickups, R = C.pickupReport;
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
  const order = row => R.orderLabel(row);
  const condition = value => ({ novo: 'Novo', meia_vida: 'Meia-vida', remold: 'Remold' })[value] || '';
  function heading(title, back) {
    const n = el('header', null, 'mp-heading');
    if (back) { const b = button('', back, 'icon', 'back'); b.setAttribute('aria-label', 'Voltar'); n.appendChild(b); }
    const h = el('h2', title); h.tabIndex = -1; n.appendChild(h); return n;
  }
  function status(row) {
    const stage = P.pickupStage(row), badge = el('span', null, 'mp-status mp-status-' + stage);
    badge.append(icon(({ waiting: 'clock', ready: 'check', arrived: 'person', installing: 'tool', completed: 'check' })[stage]), el('span', P.stageLabel(stage))); return badge;
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
  function history(row) {
    const entries = R.history(row);
    if (!entries.length) return null;
    const card = plate('mp-history'), list = el('ol');
    entries.forEach(entry => {
      const item = el('li'), instant = el('time', entry.text);
      instant.dateTime = entry.when; item.append(instant, el('span', entry.label)); list.appendChild(item);
    });
    card.append(el('h3', 'Histórico do pedido'), list); return card;
  }
  function queue(m) {
    const page = el('div', null, 'mp-page mp-queue'), top = heading('Retiradas');
    const refresh = button('', 'refresh', 'icon', 'refresh'); refresh.setAttribute('aria-label', 'Atualizar retiradas'); top.appendChild(refresh); page.appendChild(top);
    const summary = el('div', null, 'mp-kpis');
    const metrics = [
      ['Em aberto', 'person', row => P.pickupStage(row) !== 'completed'],
      ['Prontas', 'check', row => P.pickupStage(row) === 'ready' && R.expiry(row)?.level !== 'expired'],
      ['Vencem em breve', 'clock', row => R.expiry(row)?.level === 'soon'],
    ];
    metrics.forEach(([label, symbol, matches]) => {
      const box = plate(), copy = el('div'); copy.append(el('small', label), el('strong', m.phase === 'ready' ? String(P.state.rows.filter(matches).length) : '—'));
      box.append(icon(symbol), copy); summary.appendChild(box);
    }); page.appendChild(summary);
    const search = el('label', null, 'mp-search'); search.appendChild(icon('search'));
    const input = el('input'); input.id = 'mp-search'; input.type = 'search'; input.placeholder = 'Cliente ou pedido'; input.maxLength = 100; input.value = P.state.search; input.setAttribute('aria-label', 'Buscar cliente ou pedido');
    search.appendChild(input); page.appendChild(search);
    const filters = el('nav', null, 'mp-filters'); filters.setAttribute('aria-label', 'Filtrar retiradas');
    [['all', 'Todas'], ['waiting', 'A separar'], ['ready', 'Prontas'], ['arrived', 'Na loja'], ['completed', 'Concluídas']].forEach(([value, label]) => {
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
    const query = R.normalizeSearch(P.state.search);
    const rows = P.state.rows.filter(row => {
      const stage = P.pickupStage(row), filter = P.state.filter;
      return (filter === 'all' || stage === filter || (filter === 'arrived' && stage === 'installing'))
        && R.normalizeSearch([row.customer_name, row.customer_phone, row.order_number, order(row), P.itemsLabel(row)].join(' ')).includes(query);
    });
    rows.forEach(row => {
      const card = plate('mp-order'), copy = el('div', null, 'mp-order-copy'), head = el('header');
      head.append(el('h3', row.customer_name || 'Cliente não identificado'), el('small', order(row)));
      copy.append(head, el('p', P.itemsLabel(row)), status(row));
      const deadline = R.expiry(row);
      if (deadline) copy.appendChild(el('p', deadline.label, 'mp-deadline mp-deadline-' + deadline.level));
      const footer = el('footer'), open = button('Abrir', 'open', 'secondary', 'next'); open.dataset.order = row.order_id;
      footer.append(el('strong', P.money(P.fullTotal(row))), open); copy.appendChild(footer); card.append(picture(), copy); host.appendChild(card);
    });
    if (!rows.length) { const n = el('div', null, 'mp-notice'); n.append(el('strong', 'Nenhuma retirada encontrada'), el('p', query || P.state.filter !== 'all' ? 'Experimente outra busca ou filtro.' : 'Os pedidos reservados para retirada aparecerão aqui.')); host.appendChild(n); }
  }
  function arrival(row) {
    const page = el('div', null, 'mp-page mp-arrival'), head = plate('mp-detail-identity');
    head.append(el('h3', order(row)), el('p', row.customer_name || 'Cliente não identificado'), status(row));
    page.append(heading('Retiradas', 'queue'), head);
    const items = product(row, true), deadline = R.expiry(row);
    items.appendChild(totalLine('Total', P.money(P.fullTotal(row)), true));
    if (deadline) {
      const hint = el('p', null, 'mp-deadline mp-deadline-' + deadline.level);
      hint.append(icon('clock'), el('span', deadline.label)); items.appendChild(hint);
    }
    page.appendChild(items);
    const startsAt = row.fulfillment_not_before ? new Date(row.fulfillment_not_before) : null;
    const future = startsAt && startsAt.getTime() > Date.now();
    if (future) page.appendChild(el('p', 'Retirada a partir de ' + C.dateTime.format(startsAt), 'mp-hint'));
    const actions = plate('mp-detail-actions'), href = R.whatsappLink(row);
    if (href) {
      const link = el('a', null, 'mp-button mp-primary');
      link.append(icon('whatsapp'), el('span', 'Avisar no WhatsApp'));
      link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.addEventListener('click', event => R.checkWhatsapp(event, P.selected())); actions.appendChild(link);
    }
    if (P.pickupStage(row) === 'waiting' && deadline?.level !== 'expired') {
      actions.appendChild(button('Marcar como pronto', 'ready', 'primary', 'check'));
    }
    const arrive = button('Cliente chegou', 'arrived', 'secondary', 'person');
    arrive.disabled = Boolean(future); actions.appendChild(arrive); page.appendChild(actions);
    const timeline = history(row); if (timeline) page.appendChild(timeline);
    page.appendChild(button('Cancelar pedido', 'cancel', 'link-danger', 'trash')); return page;
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
