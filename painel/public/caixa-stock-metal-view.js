(function () {
  'use strict';
  const C = window.Caixa, V = C.catalogMetalView, el = V.el;
  const condition = value => ({ novo: 'Novo', meia_vida: 'Meia-vida', remold: 'Remold' })[value] || 'Condição não informada';
  const vehicle = value => ({ car: 'Carro', motorcycle: 'Moto' })[value] || 'Tipo não identificado';
  const money = value => value == null ? 'Preço não definido' : C.currency.format(Number(value));
  function button(label, action, type = 'secondary', symbol) {
    const b = V.button(label, action, type, symbol); b.dataset.msAction = action; delete b.dataset.mcgAction; return b;
  }
  function plate(title, className) {
    const p = el('section', null, 'mcg-plate ms-plate ' + (className || ''));
    if (title) p.appendChild(el('h3', title)); return p;
  }
  function heading(title, back) {
    const h = el('header', null, 'mcg-heading');
    if (back) { const b = button('', back, 'icon-button', 'back'); b.setAttribute('aria-label', 'Voltar'); h.appendChild(b); }
    const text = el('h2', title); text.tabIndex = -1; h.appendChild(text); return h;
  }
  function picture(row) {
    return C.tireIllustration(row);
  }
  function identity(row) {
    const box = plate(null, 'ms-identity'), copy = el('div');
    copy.append(el('strong', row.tire_size || row.item_name), el('p', [row.brand, condition(row.tire_condition)].filter(Boolean).join(' · ')), el('small', vehicle(row.vehicle_type)));
    box.append(picture(row), copy); return box;
  }
  function balance(row) {
    const p = plate('Saldo no estoque'), grid = el('div', null, 'ms-balance');
    [['Físico', row.quantity_on_hand], ['Reservados', row.quantity_reserved], ['Disponíveis', row.quantity_available]].forEach(([label, value]) => {
      const cell = el('div'); cell.append(el('small', label), el('strong', value == null ? '—' : String(value))); grid.appendChild(cell);
    }); p.appendChild(grid); return p;
  }
  function available(row) {
    return row.stock_status === 'out_of_stock' ? 'Sem estoque' : row.stock_status === 'reserved' ? 'Tudo reservado' : row.quantity_available + ' disponíveis';
  }
  function card(row) {
    const box = plate(null, 'ms-card'), copy = el('div'), badge = el('span', available(row), 'mcg-badge');
    if (['low_stock', 'reserved'].includes(row.stock_status)) badge.classList.add('mcg-amber');
    if (row.stock_status === 'out_of_stock') badge.classList.add('ms-red');
    copy.append(el('strong', row.tire_size || row.item_name), el('p', [row.brand, condition(row.tire_condition), vehicle(row.vehicle_type)].filter(Boolean).join(' · ')), badge,
      el('small', 'Físico ' + row.quantity_on_hand + ' · Reservados ' + row.quantity_reserved));
    if (row.stock_status === 'low_stock') copy.appendChild(el('small', 'Estoque baixo', 'ms-warning'));
    const footer = el('footer'), open = button('Ver pneu', 'detail', 'secondary', 'next'); open.dataset.stockId = row.stock_id;
    footer.append(el('b', money(row.sale_price)), open); copy.appendChild(footer); box.append(picture(row), copy); return box;
  }
  const stockFilters = [['all', 'Todos'], ['available', 'Com saldo'], ['low', 'Baixo'], ['empty', 'Sem estoque']];
  function filtered(m) {
    const query = m.query.trim().toLocaleLowerCase('pt-BR');
    return m.rows.filter(row => (!m.brand || row.brand === m.brand) && (!m.condition || row.tire_condition === m.condition)
      && (!m.vehicle || (m.vehicle === 'unknown' ? !row.vehicle_type : row.vehicle_type === m.vehicle))
      && (m.filter !== 'available' || Number(row.quantity_available) > 0)
      && (m.filter !== 'low' || row.stock_status === 'low_stock')
      && (m.filter !== 'empty' || Number(row.quantity_available) === 0)
      && (!query || [row.tire_size, row.brand, row.item_name, row.local_sku].filter(Boolean).join(' ').toLocaleLowerCase('pt-BR').includes(query)));
  }
  function list(m) {
    const page = el('div', null, 'mcg-page ms-page'), head = heading('Estoque'), refresh = button('', 'refresh', 'icon-button', 'refresh');
    refresh.setAttribute('aria-label', 'Atualizar estoque'); head.appendChild(refresh); page.appendChild(head);
    const stats = el('div', null, 'ms-stats');
    [['Disponíveis', m.rows.reduce((n, r) => n + Number(r.quantity_available), 0)], ['Reservados', m.rows.reduce((n, r) => n + Number(r.quantity_reserved), 0)], ['Estoque baixo', m.rows.filter(r => r.stock_status === 'low_stock').length]].forEach(([label, value]) => {
      const box = plate(); box.append(el('small', label), el('strong', m.loading || m.error || !m.loaded ? '—' : String(value))); stats.appendChild(box);
    }); page.appendChild(stats);
    const search = el('div', null, 'mcg-search-row'), label = el('label', null, 'mcg-search'), input = el('input');
    input.type = 'search'; input.id = 'ms-search'; input.maxLength = 100; input.placeholder = 'Medida, marca ou código'; input.value = m.query; input.setAttribute('aria-label', 'Buscar pneu no estoque');
    label.append(V.icon('search'), input); const filter = button('', 'filters', 'icon-button', 'filter'); filter.setAttribute('aria-label', 'Filtrar estoque'); search.append(label, filter); page.appendChild(search);
    const chips = el('nav', null, 'ms-chips'); chips.setAttribute('aria-label', 'Disponibilidade');
    stockFilters.forEach(([value, label]) => { const b = button(label, 'filter'); b.dataset.filter = value; b.classList.toggle('active', m.filter === value); b.setAttribute('aria-pressed', String(m.filter === value)); chips.appendChild(b); }); page.appendChild(chips);
    if (m.brand || m.condition || m.vehicle) page.appendChild(el('p', [m.brand, m.condition && condition(m.condition), m.vehicle && vehicle(m.vehicle)].filter(Boolean).join(' · '), 'ms-hint'));
    const cards = el('div', null, 'ms-cards'); cards.id = 'ms-cards'; cards.setAttribute('aria-live', 'polite'); page.appendChild(cards); fillCards(m, cards); return page;
  }
  function fillCards(m, host) {
    host.replaceChildren();
    if (m.loading || m.error || !m.loaded) { host.appendChild(el('p', m.error ? 'Não foi possível carregar o estoque.' : 'Carregando estoque…', 'mcg-notice')); if (m.error) host.appendChild(button('Tentar novamente', 'refresh', 'primary')); return; }
    const rows = filtered(m); host.append(...rows.slice(0, m.limit).map(card));
    if (!rows.length) host.appendChild(el('p', 'Nenhum pneu encontrado. Revise a busca ou os filtros.', 'mcg-notice'));
    if (rows.length > m.limit) host.appendChild(button('Carregar mais pneus', 'more'));
  }
  function select(label, name, choices, value) {
    const box = plate(label), select = el('select'); select.name = name; select.setAttribute('aria-label', label);
    choices.forEach(([key, text]) => { const option = el('option', text); option.value = key; option.selected = key === value; select.appendChild(option); }); box.appendChild(select); return box;
  }
  function filters(m) {
    const page = el('form', null, 'mcg-page ms-page'); page.id = 'ms-filter-form'; page.appendChild(heading('Filtrar estoque', 'list'));
    const box = plate('Disponibilidade'); stockFilters.forEach(([value, label]) => {
      const field = el('label', null, 'ms-radio'), input = el('input'); input.type = 'radio'; input.name = 'filter'; input.value = value; input.checked = m.filter === value;
      field.append(input, document.createTextNode(label === 'Baixo' ? 'Estoque baixo' : label)); box.appendChild(field);
    }); page.append(box, select('Condição', 'condition', [['', 'Todas as condições'], ['novo', 'Novo'], ['meia_vida', 'Meia-vida'], ['remold', 'Remold']], m.condition),
      select('Tipo de veículo', 'vehicle', [['', 'Moto e carro'], ['motorcycle', 'Moto'], ['car', 'Carro'], ['unknown', 'Não identificado']], m.vehicle),
      select('Marca', 'brand', [['', 'Todas as marcas'], ...[...new Set(m.rows.map(r => r.brand).filter(Boolean))].sort().map(brand => [brand, brand])], m.brand));
    const apply = button('Aplicar filtros', 'apply-filters', 'primary', 'filter'); apply.type = 'submit'; page.append(apply, button('Limpar filtros', 'clear-filters', 'secondary', 'refresh')); return page;
  }
  function detail(row) {
    const page = el('div', null, 'mcg-page ms-page'); page.append(heading('Pneu no estoque', 'list'), identity(row), balance(row));
    const price = plate('Preço de venda', 'ms-price'), controls = plate('Controle do estoque'); price.appendChild(el('strong', money(row.sale_price)));
    if (C.isOwner() && row.product_id) price.appendChild(button('Alterar preço', 'price', 'secondary', 'tag'));
    controls.append(el('p', row.minimum_quantity == null ? 'Estoque mínimo não informado' : 'Estoque mínimo: ' + row.minimum_quantity + ' pneus'),
      el('strong', row.stock_status === 'in_stock' ? row.minimum_quantity == null ? 'Disponível para vender' : 'Acima do mínimo' : row.stock_status === 'low_stock' ? 'Estoque baixo' : available(row)),
      el('small', row.updated_at ? 'Atualizado em ' + C.dateTime.format(new Date(row.updated_at)) : 'Atualização não informada'));
    page.append(price, controls, button('Ver reservas', 'reservations', 'secondary', 'file'), button('Movimentações', 'history', 'secondary', 'refresh'));
    if (row.product_id) page.appendChild(button('Abrir no Catálogo', 'catalog', 'link', 'link')); return page;
  }
  function reservations(m) {
    const page = el('div', null, 'mcg-page ms-page'); page.append(heading('Reservas', 'detail-back'), identity(m.stock));
    const total = plate('Reservados'); total.appendChild(el('strong', m.stock.quantity_reserved + ' pneus', 'ms-big')); page.appendChild(total);
    if (!m.loading && !m.error) {
      m.items.forEach(row => { const box = plate(null, 'ms-order'); box.append(el('strong', row.order_number || 'Pedido ' + row.order_id.slice(0, 8)), el('p', row.customer_name || 'Cliente não informado'), el('p', row.quantity + (row.quantity === 1 ? ' pneu' : ' pneus') + ' · ' + (row.fulfillment_mode === 'pickup' ? 'Retirada' : 'Entrega')), el('span', 'Reservado', 'mcg-badge'));
        if (C.canModule('vendas')) { const b = button('Ver pedido', 'order', 'secondary', 'next'); b.dataset.orderId = row.order_id; box.appendChild(b); } page.appendChild(box); });
      if (!m.items.length) page.appendChild(el('p', m.stock.quantity_reserved > 0 ? 'O saldo indica reservas, mas não encontramos pedidos vinculados. Confira a operação.' : 'Nenhum pedido com reserva ativa para este pneu.', 'mcg-notice'));
      page.appendChild(el('p', 'Reservas vinculadas aos pedidos.', 'ms-hint'));
    } return remote(page, m);
  }
  function history(m) {
    const page = el('div', null, 'mcg-page ms-page'); page.append(heading('Movimentações', 'detail-back'), identity(m.stock),
      select('Período', 'days', [['30', 'Últimos 30 dias'], ['90', 'Últimos 90 dias'], ['all', 'Todo o histórico']], m.days));
    if (!m.loading && !m.error) {
      const box = plate('Histórico de movimentações', 'ms-history');
      m.items.forEach(row => { const line = el('article'), delta = Number(row.quantity_delta), reservation = row.kind === 'reservation';
        const consumed = row.source === 'matriz_galpao_decrement';
        const title = reservation ? consumed ? 'Reserva concluída' : delta > 0 ? 'Reserva' : 'Reserva liberada' : row.label || (delta > 0 ? 'Entrada no estoque' : 'Saída do estoque');
        const copy = el('div'); copy.append(el('strong', C.dateTime.format(new Date(row.occurred_at))), el('p', title + (row.order_number ? ' · ' + row.order_number : '')));
        const amount = el('b', reservation ? Math.abs(delta) + (delta === 1 || delta === -1 ? ' pneu ' : ' pneus ') + (consumed ? 'entregue' : delta > 0 ? 'reservado' : 'liberado') + (Math.abs(delta) === 1 ? '' : 's') : (delta > 0 ? '+' : '−') + Math.abs(delta) + ' pneus', reservation ? 'ms-warning' : delta > 0 ? 'ms-positive' : 'ms-negative');
        line.append(copy, amount); box.appendChild(line); });
      if (!m.items.length) box.appendChild(el('p', 'Nenhuma movimentação neste período.', 'mcg-notice')); page.appendChild(box);
    } remote(page, m); page.appendChild(balance(m.stock)); return page;
  }
  function remote(page, m) {
    if (m.loading || m.error) page.appendChild(el('p', m.error ? 'Não foi possível carregar. Tente novamente.' : 'Carregando…', 'mcg-notice'));
    if (m.error) page.appendChild(button('Tentar novamente', 'reload', 'primary'));
    if (!m.loading && !m.error && m.hasMore) page.appendChild(button('Carregar mais', 'next-page'));
    return page;
  }
  C.matrixStockView = { el, button, picture, identity, list, fillCards, filters, detail, reservations, history };
}());
