(function () {
  'use strict';
  const C = window.Caixa, U = C.operationCatalogUtils;
  const e = value => String(value ?? '').replace(/[&<>"']/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[x]);
  const paths = { back: 'm14 5-7 7 7 7', next: 'm9 5 7 7-7 7', search: 'M19 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0m-2 5 5 6',
    chart: 'M4 20h16M7 16v-4m5 4V8m5 8V4',
    filter: 'M3 5h18M6 12h12M9 19h6', check: 'm5 12 4 4L19 6', plus: 'M12 4v16M4 12h16',
    camera: 'M3 7h4l2-3h6l2 3h4v14H3V7Zm13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
    video: 'M3 5h12v14H3V5Zm12 5 6-4v12l-6-4', photo: 'M3 3h18v18H3zM3 17l6-6 5 5 3-3 4 4M8 7h.01',
    tag: 'M3 3h10l8 8-10 10-8-8V3Zm5 5h.01', car: 'M3 12h18l-3-7H6l-3 7Zm0 0v7h18v-7M6 19v3m12-3v3M6 15h2m8 0h2',
    file: 'M5 2h10l4 4v16H5V2Zm10 0v5h4M8 11h8m-8 4h8m-8 4h5', refresh: 'M20 5v6h-6M4 19v-6h6M5 8a8 8 0 0 1 13-3l2 3M4 16l2 3a8 8 0 0 0 13-3',
    warning: 'm12 3 10 18H2L12 3Zm0 6v5m0 3v1', play: 'm9 5 10 7-10 7V5Z', link: 'm10 7 3-3a5 5 0 0 1 7 7l-3 3M14 17l-3 3a5 5 0 0 1-7-7l3-3m1 8 8-8',
  };
  const iconHTML = name => '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="' + (paths[name] || paths.next) + '"></path></svg>';
  function el(tag, text, className) { const n = document.createElement(tag); if (text != null) n.textContent = text; if (className) n.className = className; return n; }
  function icon(name) { const n = el('span', null, 'mcg-icon'); n.innerHTML = iconHTML(name); return n; }
  function button(label, action, type = 'secondary', symbol) { const n = el('button', null, 'mcg-button mcg-' + type); n.type = 'button'; n.dataset.mcgAction = action; if (symbol) n.appendChild(icon(symbol)); n.appendChild(el('span', label)); return n; }
  const plate = name => el('section', null, 'mcg-plate ' + (name || ''));
  const key = row => String(row.row_key || row.product_id || [row.tire_size, row.brand, row.tire_condition].join('|'));
  const meta = row => [row.brand, U.conditionLabel(row.tire_condition)].filter(Boolean).join(' · ');
  function picture(row) { return C.tireIllustration(row); }
  function identity(row, compact, includeModel) {
    const box = plate('mcg-product' + (compact ? ' mcg-product-compact' : '')), copy = el('div');
    copy.append(el('strong', row.tire_size || row.product_name || 'Pneu'), el('p', meta(row)));
    if (includeModel) {
      const specs = [row.tread_pattern, U.positionLabel(row.tire_position)].filter(Boolean).join(' · ');
      if (specs) copy.appendChild(el('small', specs));
    }
    if (row.product_code) copy.appendChild(el('small', 'Código ' + row.product_code)); box.append(picture(row), copy); return box;
  }
  function heading(title, back) { const n = el('header', null, 'mcg-heading'); if (back) { const b = button('', back, 'icon-button', 'back'); b.setAttribute('aria-label', 'Voltar'); n.appendChild(b); } const h = el('h2', title); h.tabIndex = -1; n.appendChild(h); return n; }
  function list(m, state) {
    const page = el('div', null, 'mcg-page'), stats = el('div', null, 'mcg-stats');
    [['products', 'produtos'], ['brands', 'marcas'], ['without_local_price', 'sem preço']].forEach(([id, label]) => { const n = plate(); n.append(el('strong', state.loading || state.error || !state.loaded ? '—' : String(state.summary[id] ?? 0)), el('small', label)); stats.appendChild(n); }); page.appendChild(stats);
    const search = el('div', null, 'mcg-search-row'), label = el('label', null, 'mcg-search'), input = el('input');
    input.id = 'mcg-search'; input.type = 'search'; input.maxLength = 100; input.placeholder = 'Medida, marca ou produto'; input.value = state.query; input.setAttribute('aria-label', 'Buscar pneu no catálogo'); label.append(icon('search'), input);
    const filter = button('', 'filters', 'icon-button', 'filter'); filter.setAttribute('aria-label', 'Filtrar catálogo'); search.append(label, filter); page.appendChild(search);
    const brands = el('nav', null, 'mcg-brands'); brands.setAttribute('aria-label', 'Marcas');
    const present = new Set(state.rows.map(row => String(row.brand || '').toLocaleLowerCase('pt-BR')));
    ['', ...state.brands.filter(brand => present.has(brand.toLocaleLowerCase('pt-BR')) || brand === state.brand)].forEach(brand => { const b = button(brand || 'Todas', 'brand'); b.dataset.brand = brand; b.classList.toggle('active', state.brand === brand); b.setAttribute('aria-pressed', String(state.brand === brand)); brands.appendChild(b); }); page.appendChild(brands);
    const filters = el('nav', null, 'mcg-filters'); filters.setAttribute('aria-label', 'Disponibilidade');
    [['all', 'Todos'], ['stock', 'Com estoque'], ['no_price', 'Sem preço']].forEach(([value, label]) => { const b = button(label, 'filter'); b.dataset.filter = value; b.id = 'mcg-filter-' + value; b.classList.toggle('active', state.filter === value); b.setAttribute('aria-pressed', String(state.filter === value)); filters.appendChild(b); }); page.appendChild(filters);
    const cards = el('div', null, 'mcg-cards'); cards.id = 'mcg-product-list'; cards.setAttribute('aria-live', 'polite'); page.appendChild(cards);
    if (C.matrixCatalog.allowed()) page.appendChild(button('Cadastrar pneu', 'create', 'primary', 'plus')); return page;
  }
  function filtered(state) { const query = state.query.toLocaleLowerCase('pt-BR'); return state.rows.filter(row => (!state.brand || String(row.brand || '').toLocaleLowerCase('pt-BR') === state.brand.toLocaleLowerCase('pt-BR'))
    && (state.filter !== 'stock' || U.available(row) > 0) && (state.filter !== 'no_price' || !U.priceRange(row))
    && (!query || [row.tire_size, row.brand, row.product_name, row.product_code, row.application_search].filter(Boolean).join(' ').toLocaleLowerCase('pt-BR').includes(query))); }
  function cards(m, state, host) {
    host.replaceChildren();
    if (state.loading || state.error || !state.loaded) { host.appendChild(el('p', state.error ? 'Não foi possível carregar o catálogo.' : 'Carregando catálogo…', 'mcg-notice')); if (state.error) host.appendChild(button('Tentar novamente', 'refresh', 'primary')); return; }
    const rows = filtered(state); rows.slice(0, m.page * 20).forEach(row => {
      const card = plate('mcg-card'), copy = el('div'), open = button(row.product_id ? 'Ver pneu' : 'Completar cadastro', row.product_id ? 'detail' : 'complete', row.product_id ? 'primary' : 'secondary', 'next'); open.dataset.key = key(row);
      copy.append(el('strong', row.tire_size || row.product_name || 'Produto'), el('p', meta(row)));
      const badge = el('span', row.catalogued ? U.available(row) + ' disponíveis' : 'Cadastro pendente', 'mcg-badge' + (row.catalogued ? '' : ' mcg-amber')); copy.appendChild(badge);
      const footer = el('footer'); footer.append(el('b', U.priceLabel(row)));
      if (row.product_id || C.matrixCatalog.allowed()) footer.appendChild(open); copy.appendChild(footer); card.append(picture(row), copy); host.appendChild(card);
    });
    if (!rows.length) host.appendChild(el('p', 'Nenhum pneu encontrado. Revise a busca ou os filtros.', 'mcg-notice'));
    if (rows.length > m.page * 20) host.appendChild(button('Carregar mais pneus', 'more'));
  }
  const percentFormat = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
  const pct = value => value == null ? '—' : percentFormat.format(value) + '%';
  const ordersLabel = count => count + (count === 1 ? ' pedido' : ' pedidos');
  function detailTabs(active) {
    const tabs = el('div', null, 'mcg-detail-tabs');
    tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Informações do pneu');
    for (const [id, label, symbol] of [['info', 'Ficha do pneu', 'file'], ['stats', 'Estatísticas', 'chart']]) {
      const tab = button(label, 'tab-' + id, active === id ? 'primary' : 'secondary', symbol);
      tab.id = 'mcg-tab-' + id; tab.tabIndex = active === id ? 0 : -1;
      tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(active === id));
      tab.setAttribute('aria-controls', 'mcg-detail-panel'); tabs.appendChild(tab);
    }
    return tabs;
  }
  function shareCard(share, weeks, row) {
    const card = plate('mcg-metric');
    card.append(el('h3', 'Participação na medida'), el('strong', pct(share.percent), 'mcg-metric-value'));
    if (share.percent != null) {
      card.appendChild(el('p', share.units + ' de ' + share.total + ' pneus ' + (row.tire_size || '') + ' vendidos na mesma condição e tipo de veículo.'));
    } else {
      card.appendChild(el('p', 'Sem base comparável para esta medida no período.'));
    }
    if (share.delta_pp != null) {
      const delta = share.delta_pp;
      card.appendChild(el('p', (delta > 0 ? '+' : '') + percentFormat.format(delta) + ' p.p. sobre as 4 semanas anteriores', 'mcg-metric-note'));
    }
    const chart = el('ol', null, 'mcg-week-chart');
    chart.setAttribute('aria-label', 'Participação por semana, da mais antiga à mais recente');
    weeks.forEach((week, i) => {
      const item = el('li'), plot = el('div', null, 'mcg-week-plot'), bar = el('span', null, 'mcg-week-bar');
      bar.style.height = (week.percent ?? 0) + '%';
      plot.setAttribute('aria-hidden', 'true'); bar.appendChild(el('b', pct(week.percent))); plot.appendChild(bar);
      item.append(plot, el('span', 'Sem. ' + (i + 1)));
      item.setAttribute('aria-label', 'Semana ' + (i + 1) + (week.percent == null ? ', sem base comparável' : ', ' + pct(week.percent) + ', ' + week.units + ' de ' + week.total + ' pneus'));
      chart.appendChild(item);
    });
    card.appendChild(chart); return card;
  }
  function meter(value) {
    const track = el('div', null, 'mcg-metric-track'), fill = el('span');
    track.setAttribute('aria-hidden', 'true'); fill.style.width = value + '%'; track.appendChild(fill); return track;
  }
  function basketCard(basket) {
    const card = plate('mcg-metric');
    card.append(el('h3', 'O que vende junto'), el('p', ordersLabel(basket.orders) + ' com este pneu'));
    const more = el('details', null, 'mcg-basket-more');
    if (basket.items.length > 5) more.appendChild(el('summary', 'Ver todos os ' + basket.items.length + ' produtos'));
    basket.items.forEach((item, index) => {
      const line = el('div', null, 'mcg-metric-row');
      line.append(el('span', item.label), el('b', ordersLabel(item.orders)));
      const list = index < 5 ? card : more;
      list.append(line, meter(item.orders / basket.orders * 100));
    });
    if (basket.items.length > 5) card.appendChild(more);
    if (!basket.items.length && basket.orders) card.appendChild(el('p', 'Nenhum outro produto identificado nesses pedidos.', 'mcg-metric-note'));
    return card;
  }
  function discountCard(discount) {
    const card = plate('mcg-metric');
    card.append(el('h3', 'Vendas sem desconto'), el('strong', pct(discount.percent), 'mcg-metric-value'));
    if (discount.eligible_orders) {
      card.append(el('p', discount.orders_without_discount + ' de ' + ordersLabel(discount.eligible_orders) + (discount.eligible_orders === 1 ? ' avaliado' : ' avaliados')),
        meter(discount.percent));
    } else {
      card.appendChild(el('p', discount.unknown_orders ? 'Sem base para verificar o desconto.' : 'Nenhum pedido com este pneu no período.'));
    }
    if (discount.unknown_orders) card.appendChild(el('p', 'Sem referência suficiente em ' + ordersLabel(discount.unknown_orders) + '.', 'mcg-metric-note'));
    return card;
  }
  function showStats(body, stats, row) {
    body.appendChild(el('p', 'Varejo da Matriz · Últimas 4 semanas', 'mcg-hint'));
    if (!stats.data) {
      const status = el('p', stats.error ? 'Não foi possível carregar as estatísticas deste pneu.' : 'Carregando estatísticas…', stats.error ? 'mcg-error' : 'mcg-notice');
      status.setAttribute('role', stats.error ? 'alert' : 'status'); body.appendChild(status);
      if (stats.error) body.appendChild(button('Tentar novamente', 'retry-stats', 'primary', 'refresh'));
      return;
    }
    const data = stats.data;
    body.append(shareCard(data.share, data.weeks, row), basketCard(data.basket), discountCard(data.discount));
  }
  function detail(row, stats) {
    const tire = row.product_type === 'tire', page = el('div', null, 'mcg-page'); page.append(heading(tire ? 'Pneu do catálogo' : 'Produto do catálogo', 'products'), identity(row, false, !!stats));
    const owner = C.matrixCatalog.allowed();
    let body = page;
    if (owner && tire && row.product_id) {
      const active = stats ? 'stats' : 'info';
      body = el('div', null, 'mcg-page'); body.id = 'mcg-detail-panel'; body.tabIndex = 0;
      body.setAttribute('role', 'tabpanel'); body.setAttribute('aria-labelledby', 'mcg-tab-' + active);
      page.append(detailTabs(active), body);
      if (stats) { showStats(body, stats, row); return page; }
    }
    const price = plate('mcg-price-summary'), value = el('div'); value.append(el('small', 'Preço de venda'), el('strong', U.priceLabel(row))); price.append(value, el('span', U.available(row) + ' disponíveis')); body.appendChild(price);
    if (owner) { if (tire) body.appendChild(button('Ficha técnica', 'spec', 'secondary', 'file')); body.appendChild(button('Alterar preço', 'price', 'secondary', 'tag')); }
    else { const spec = plate(); [['Tipo de veículo', ({ motorcycle: 'Moto', car: 'Carro' })[row.vehicle_type]], ['Posição no veículo', U.positionLabel(row.tire_position)], ['Modelo / desenho', row.tread_pattern], ['Índice de carga', row.load_index], ['Velocidade', row.speed_rating]].forEach(([label, value]) => { const p = el('p'); p.append(el('strong', label + ': '), document.createTextNode(value || 'Não informado')); spec.appendChild(p); }); body.appendChild(spec); }
    if (tire) body.appendChild(button('Compatibilidade', 'fitments', 'secondary', 'car'));
    if (owner && tire) body.appendChild(button('Fotos e vídeos para o bot', 'media', 'secondary', 'photo'));
    body.appendChild(el('p', row.catalogued ? 'Cadastro completo' : 'Cadastro pendente', 'mcg-badge' + (row.catalogued ? '' : ' mcg-amber'))); return page;
  }
  function filterForm(state) {
    const form = el('form'); form.id = 'mcg-filter-form'; form.appendChild(heading('Filtrar catálogo', 'close-filters'));
    const searchLabel = el('label', 'Medida ou marca'), input = el('input'); input.name = 'query'; input.id = 'mcg-filter-query'; input.value = state.query; input.maxLength = 100; searchLabel.appendChild(input); form.appendChild(searchLabel);
    [['brand', 'Marcas', [['', 'Todas'], ...state.brands.map(brand => [brand, brand])], state.brand], ['filter', 'Disponibilidade', [['all', 'Todos os pneus'], ['stock', 'Com estoque'], ['no_price', 'Sem preço']], state.filter]].forEach(([name, title, options, selected]) => {
      const group = el('fieldset', null, 'mcg-plate mcg-radio-group'); group.appendChild(el('legend', title)); options.forEach(([value, label]) => { const n = el('label'), radio = el('input'); radio.type = 'radio'; radio.name = name; radio.value = value; radio.checked = value === selected; n.append(radio, el('span', label)); group.appendChild(n); }); form.appendChild(group);
    });
    const apply = button('Aplicar filtros', 'apply-filters', 'primary', 'filter'); apply.type = 'submit'; form.append(apply, button('Limpar filtros', 'clear-filters', 'secondary', 'refresh')); return form;
  }
  C.catalogMetalView = { e, el, icon, iconHTML, button, plate, key, meta, picture, identity, heading, list, cards, filtered, detail, filterForm };
}());
