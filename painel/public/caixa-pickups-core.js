(function () {
  'use strict';
  const Caixa = window.Caixa;
  const panel = document.getElementById('pickups-panel');
  if (!Caixa || !panel) return;
  const byId = function (id) { return document.getElementById(id); };
  const elements = {
    panel: panel,
    waiting: byId('pickups-count-waiting'), arrived: byId('pickups-count-arrived'),
    installing: byId('pickups-count-installing'), completed: byId('pickups-count-completed'),
    search: byId('pickups-search'), refresh: byId('pickups-refresh'),
    loading: byId('pickups-loading'), error: byId('pickups-error'), retry: byId('pickups-retry'),
    empty: byId('pickups-empty'), list: byId('pickups-list'), sheet: byId('pickups-sheet'),
    sheetTitle: byId('pickups-sheet-title'), sheetCustomer: byId('pickups-sheet-customer'),
    sheetStatus: byId('pickups-sheet-status'), sheetItems: byId('pickups-sheet-items'),
    serviceList: byId('pickups-services-list'), addService: byId('pickups-add-service'),
    productTotal: byId('pickups-product-total'), servicesTotal: byId('pickups-services-total'),
    grandTotal: byId('pickups-grand-total'), sheetError: byId('pickups-sheet-error'),
    backStage: byId('pickups-back-stage'), stageAction: byId('pickups-stage-action'),
    completeAction: byId('pickups-complete-action'), cancelOpen: byId('pickups-cancel-open'),
    cancelForm: byId('pickups-cancel-form'), cancelReason: byId('pickups-cancel-reason'),
    cancelBack: byId('pickups-cancel-back'),
  };
  const state = {
    rows: [], serviceCatalog: [], filter: 'all', search: '', selectedId: '',
    payments: {}, services: {}, request: null, saving: false,
  };

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function svg(path) { return Caixa.createSvg([{ d: path }]); }
  function money(value) {
    const number = Number(value || 0);
    return Caixa.currency.format(Number.isFinite(number) ? number : 0);
  }
  function orderLabel(row) {
    const raw = String(row && row.order_id || '');
    return 'Pedido #' + (raw.includes('-') ? raw.slice(0, 8).toUpperCase() : raw);
  }
  function pickupStage(row) {
    if (!row) return 'waiting';
    if (row.retrieved_at || (row.status === 'paid' && row.awaiting_pickup === false)) return 'completed';
    if (row.pickup_installation_started_at) return 'installing';
    if (row.pickup_arrived_at) return 'arrived';
    return 'waiting';
  }
  function stageLabel(stage) {
    return ({ waiting: 'Aguardando cliente', arrived: 'Na loja', installing: 'Em instalação', completed: 'Concluída' })[stage]
      || 'Aguardando cliente';
  }
  function isToday(value) {
    if (!value) return false;
    const options = { timeZone: 'America/Sao_Paulo' };
    return new Date(value).toLocaleDateString('en-CA', options)
      === new Date().toLocaleDateString('en-CA', options);
  }
  function productItems(row) {
    return Array.isArray(row && row.items)
      ? row.items.filter(function (item) { return !item.pickup_service_code; }) : [];
  }
  function itemsLabel(row) {
    const items = productItems(row);
    if (!items.length) return 'Itens do pedido não informados';
    return items.map(function (item) {
      const quantity = Number(item.quantity || 0);
      const name = item.tire_size || item.product_name || item.item_name || 'Item';
      return quantity + '× ' + name + (item.brand ? ' ' + item.brand : '');
    }).join(' · ');
  }
  function whatsappLink(row) {
    let digits = String(row && row.customer_phone || '').replace(/\D/g, '');
    if (digits.length === 10 || digits.length === 11) digits = '55' + digits;
    if (!digits) return '';
    const message = encodeURIComponent('Olá! Seu pedido está reservado e pronto para retirada na loja.');
    return 'https://wa.me/' + digits + '?text=' + message;
  }
  function selected() {
    return state.rows.find(function (row) { return row.order_id === state.selectedId; }) || null;
  }
  function normalizedPayment(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'dinheiro' || normalized === 'cash') return 'Dinheiro';
    if (normalized === 'cartão' || normalized === 'cartao' || normalized === 'card') return 'Cartão';
    return 'Pix';
  }
  function draftServices(row) { return state.services[row && row.order_id] || []; }
  function servicesCents(row) {
    return draftServices(row).reduce(function (total, service) {
      return total + Math.max(0, Number(service.amount_cents || 0));
    }, 0);
  }
  function fullTotal(row) {
    const pending = pickupStage(row) === 'completed' ? 0 : servicesCents(row) / 100;
    return Number(row && row.total_amount || 0) + pending;
  }
  function setStateView(kind) {
    elements.loading.classList.toggle('hidden', kind !== 'loading');
    elements.error.classList.toggle('hidden', kind !== 'error');
    elements.empty.classList.toggle('hidden', kind !== 'empty');
    elements.list.classList.toggle('hidden', kind !== 'ready');
  }
  function renderSummary() {
    const summary = { waiting: 0, arrived: 0, installing: 0, completed: 0 };
    state.rows.forEach(function (row) {
      const stage = pickupStage(row);
      if (stage === 'waiting') summary.waiting += 1;
      if (isToday(row.pickup_arrived_at)) summary.arrived += 1;
      if (stage === 'installing') summary.installing += 1;
      if (stage === 'completed' && isToday(row.retrieved_at)) summary.completed += 1;
    });
    elements.waiting.textContent = String(summary.waiting);
    elements.arrived.textContent = String(summary.arrived);
    elements.installing.textContent = String(summary.installing);
    elements.completed.textContent = String(summary.completed);
  }
  function filteredRows() {
    const query = state.search.trim().toLowerCase();
    return state.rows.filter(function (row) {
      const stage = pickupStage(row);
      if (state.filter !== 'all' && state.filter !== stage) return false;
      if (!query) return true;
      return [row.customer_name, row.customer_phone, row.order_id, itemsLabel(row)]
        .join(' ').toLowerCase().includes(query);
    });
  }
  function statusBadge(row) {
    const stage = pickupStage(row);
    const badge = node('span', 'pickup-status pickup-status--' + stage);
    const path = stage === 'installing'
      ? 'm14.7 6.3 3-3a5 5 0 0 1-6.4 6.4l-6.6 6.6a2.1 2.1 0 0 0 3 3l6.6-6.6a5 5 0 0 1 6.4-6.4l-3 3-3-3Z'
      : stage === 'completed' ? 'm8 12 2.5 2.5L16 9'
        : stage === 'arrived' ? 'M4 10h16M5 10v10h14V10M3 6h18l-1 4H4L3 6Z' : 'M12 7v5l3 2';
    badge.appendChild(svg(path));
    badge.appendChild(document.createTextNode(stageLabel(stage)));
    return badge;
  }
  function openSelected(orderId) {
    state.selectedId = orderId;
    elements.cancelForm.classList.add('hidden');
    elements.sheetError.textContent = '';
    if (Caixa.Pickups.renderSheet) Caixa.Pickups.renderSheet();
    elements.sheet.classList.remove('hidden');
    document.body.classList.add('pickup-sheet-open');
  }
  function closeSheet() {
    elements.sheet.classList.add('hidden');
    elements.cancelForm.classList.add('hidden');
    elements.sheetError.textContent = '';
    document.body.classList.remove('pickup-sheet-open');
  }
  function renderCard(row) {
    const card = node('article', 'pickup-card');
    card.dataset.pickupId = row.order_id;
    const header = node('header');
    header.append(node('strong', '', orderLabel(row)), statusBadge(row));
    card.appendChild(header);
    const customer = node('p', 'pickup-card-customer');
    customer.append(svg('M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21a8 8 0 0 1 16 0'),
      document.createTextNode(row.customer_name || 'Cliente não identificado'));
    card.appendChild(customer);
    const items = node('p', 'pickup-card-items');
    items.append(svg('M7 3c3 0 4 4 4 9s-1 9-4 9-4-4-4-9 1-9 4-9Zm10 0c3 0 4 4 4 9s-1 9-4 9-4-4-4-9 1-9 4-9Z'),
      document.createTextNode(itemsLabel(row)));
    card.appendChild(items);
    const footer = node('footer');
    footer.appendChild(node('strong', '', money(fullTotal(row))));
    const actions = node('div');
    const wa = whatsappLink(row);
    if (wa) {
      const link = node('a', 'pickup-card-whatsapp', 'WhatsApp');
      link.href = wa; link.target = '_blank'; link.rel = 'noopener noreferrer'; actions.appendChild(link);
    }
    const open = node('button', 'pickup-card-open', pickupStage(row) === 'waiting' ? 'Cliente chegou' : 'Abrir atendimento');
    open.type = 'button'; open.dataset.openPickup = row.order_id; actions.appendChild(open);
    footer.appendChild(actions); card.appendChild(footer);
    return card;
  }
  function renderList() {
    renderSummary();
    const rows = filteredRows();
    elements.list.replaceChildren();
    if (!rows.length) return setStateView('empty');
    rows.forEach(function (row) { elements.list.appendChild(renderCard(row)); });
    setStateView('ready');
  }

  Caixa.Pickups = {
    elements: elements, state: state, node: node, money: money, orderLabel: orderLabel,
    pickupStage: pickupStage, stageLabel: stageLabel, itemsLabel: itemsLabel,
    selected: selected, normalizedPayment: normalizedPayment, draftServices: draftServices,
    servicesCents: servicesCents, fullTotal: fullTotal, setStateView: setStateView,
    renderList: renderList, openSelected: openSelected, closeSheet: closeSheet,
  };
}());
