(function () {
  'use strict';

  const Caixa = window.Caixa;
  const els = {
    list: document.getElementById('deliveries-list'),
    loading: document.getElementById('deliveries-loading'),
    error: document.getElementById('deliveries-error'),
    empty: document.getElementById('deliveries-empty'),
    search: document.getElementById('delivery-search-input'),
    pending: document.getElementById('delivery-count-pending'),
    dispatched: document.getElementById('delivery-count-dispatched'),
    delivered: document.getElementById('delivery-count-delivered'),
  };
  const state = { rows: [], filter: 'dispatched', query: '', request: null, photos: new Map() };

  function svg(path) { return Caixa.createSvg([{ d: path }]); }
  function normalize(value) { return String(value || '').trim().toLocaleLowerCase('pt-BR'); }
  function operatorName() { return Caixa.stored(Caixa.keys.name) || 'Operador'; }
  function orderLabel(id) { return '#' + String(id || '').replace(/-/g, '').slice(0, 6).toUpperCase(); }
  function statusLabel(status) {
    if (status === 'dispatched') return 'Em rota';
    if (status === 'delivered') return 'Entregue';
    if (status === 'failed') return 'Não entregue';
    return 'Aguardando saída';
  }
  function paymentLabel(row) {
    if (row.delivery_status === 'delivered') return `${row.payment_method || 'Pagamento'} • Pago`;
    const method = normalize(row.payment_method);
    if (!method || method === 'a receber') return 'Pagamento na entrega';
    return `${row.payment_method} • A receber`;
  }
  function itemLabel(row) {
    const items = Array.isArray(row.items) ? row.items : [];
    if (!items.length) return 'Produto do pedido';
    return items.map(function (item) {
      return `${item.label || 'Item'} • ${Number(item.quantity || 0)} un.`;
    }).join(' · ');
  }
  function assignedToMe(row) {
    return normalize(row.delivery_courier) === normalize(operatorName());
  }
  function phoneHref(phone, whatsapp) {
    let digits = String(phone || '').replace(/\D/g, '');
    if (digits.length === 10 || digits.length === 11) digits = '55' + digits;
    return whatsapp ? `https://wa.me/${digits}` : `tel:+${digits}`;
  }

  function metaRow(iconPath, text, strong) {
    const line = document.createElement('p');
    line.className = 'delivery-meta';
    line.appendChild(svg(iconPath));
    const copy = document.createElement('span');
    if (strong) {
      const prefix = document.createElement('strong'); prefix.textContent = strong;
      copy.append(prefix, document.createTextNode(text));
    } else copy.textContent = text;
    line.appendChild(copy);
    return line;
  }

  async function loadPhoto(photoId, image, badge) {
    if (!photoId) return;
    if (state.photos.has(photoId)) {
      image.src = state.photos.get(photoId); badge.textContent = 'FOTO DO PRODUTO'; return;
    }
    try {
      const response = await Caixa.authenticatedFetch(
        Caixa.operationPath(`operacao/entregas/fotos/${encodeURIComponent(photoId)}`),
      );
      if (!response.ok) return;
      const url = URL.createObjectURL(await response.blob());
      state.photos.set(photoId, url); image.src = url; badge.textContent = 'FOTO DO PRODUTO';
    } catch (failure) {
      if (failure instanceof Error && failure.message === 'invalid_session') return;
    }
  }

  function actionButton(label, action, primary) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = primary ? 'delivery-main-action' : 'delivery-outline-action';
    button.dataset.deliveryAction = action; button.textContent = label;
    return button;
  }

  function renderActions(row, card) {
    const actions = document.createElement('div'); actions.className = 'delivery-actions';
    if (row.delivery_status === 'pending' && !row.delivery_courier) {
      actions.appendChild(actionButton('Assumir entrega', 'claim', true));
    } else if (row.delivery_status === 'pending' && assignedToMe(row)) {
      actions.appendChild(actionButton('Iniciar entrega', 'dispatch', true));
    } else if (row.delivery_status === 'pending') {
      const assigned = actionButton(`Com ${row.delivery_courier}`, 'assigned', false); assigned.disabled = true;
      actions.appendChild(assigned);
    } else if (row.delivery_status === 'dispatched') {
      actions.appendChild(actionButton('Ver rota', 'route', true));
      if (row.customer_phone) {
        const phone = document.createElement('a'); phone.href = phoneHref(row.customer_phone, false);
        phone.className = 'delivery-contact'; phone.setAttribute('aria-label', 'Ligar para o cliente');
        phone.appendChild(svg('M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.9a2 2 0 0 1-.5 2.1L8 10a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c1 .3 1.9.6 2.9.7a2 2 0 0 1 1.7 2Z'));
        const whats = document.createElement('a'); whats.href = phoneHref(row.customer_phone, true);
        whats.target = '_blank'; whats.rel = 'noopener'; whats.className = 'delivery-contact';
        whats.setAttribute('aria-label', 'Abrir WhatsApp do cliente');
        whats.appendChild(svg('M21 11.5a8.4 8.4 0 0 1-9 8.4 8.8 8.8 0 0 1-3.7-.9L3 21l1.8-5a8.6 8.6 0 1 1 16.2-4.5Z'));
        actions.append(phone, whats);
      }
      if (assignedToMe(row)) actions.appendChild(actionButton('Confirmar entrega', 'payment', false));
    }
    if (actions.childElementCount) card.appendChild(actions);
  }

  function renderPaymentChoices(row, card) {
    const choices = document.createElement('div'); choices.className = 'delivery-payment-choices hidden';
    const label = document.createElement('strong'); label.textContent = 'Como o cliente pagou?'; choices.appendChild(label);
    ['pix', 'cartao', 'dinheiro'].forEach(function (method) {
      const button = document.createElement('button'); button.type = 'button';
      button.dataset.deliveryAction = 'deliver'; button.dataset.payment = method;
      button.textContent = method === 'cartao' ? 'Cartão' : method[0].toUpperCase() + method.slice(1);
      choices.appendChild(button);
    });
    card.appendChild(choices);
  }

  function renderCard(row) {
    const card = document.createElement('article'); card.className = `delivery-card delivery-card--${row.delivery_status}`;
    card.dataset.orderId = row.order_id; card.dataset.address = row.delivery_address || '';
    const head = document.createElement('header');
    const title = document.createElement('h4'); title.textContent = `Pedido ${orderLabel(row.order_id)}`;
    const status = document.createElement('span'); status.className = 'delivery-status'; status.textContent = statusLabel(row.delivery_status);
    head.append(title, status); card.appendChild(head);
    card.appendChild(metaRow('M20 21a8 8 0 0 0-16 0M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', row.customer_name || 'Cliente não identificado'));
    card.appendChild(metaRow('M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0ZM12 10h.01', row.delivery_address || 'Endereço não informado'));
    card.appendChild(metaRow('M3 6h18v12H3zM3 9a3 3 0 0 0 3-3m12 0a3 3 0 0 0 3 3', paymentLabel(row)));
    card.appendChild(metaRow('M20 21a8 8 0 0 0-16 0M12 11a4 4 0 1 0 0 0-8 4 4 0 0 0 0 8Z', row.delivery_courier || 'Não atribuído', 'Entregador: '));
    const product = document.createElement('div'); product.className = 'delivery-product';
    const visual = document.createElement('div'); visual.className = 'delivery-product-visual';
    const image = document.createElement('img'); image.src = '/caixa/catalog-tire.webp'; image.alt = '';
    const badge = document.createElement('span'); badge.textContent = row.photo_request_id ? 'CARREGANDO FOTO' : 'REFERÊNCIA DO PRODUTO';
    visual.append(image, badge);
    const item = document.createElement('strong'); item.textContent = itemLabel(row);
    product.append(visual, item); card.appendChild(product);
    renderActions(row, card); renderPaymentChoices(row, card);
    void loadPhoto(row.photo_request_id, image, badge);
    return card;
  }

  function selectFilter(filter) {
    state.filter = filter;
    document.querySelectorAll('[data-delivery-filter]').forEach(function (button) {
      const active = button.dataset.deliveryFilter === filter;
      button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
    });
    render();
  }

  function render() {
    const query = normalize(state.query);
    const rows = state.rows.filter(function (row) {
      const status = state.filter === 'pending'
        ? row.delivery_status === 'pending' || row.delivery_status === 'failed'
        : row.delivery_status === state.filter;
      if (!status) return false;
      return !query || normalize([row.order_id, row.customer_name, row.delivery_address, itemLabel(row)].join(' ')).includes(query);
    });
    els.list.replaceChildren(...rows.map(renderCard));
    els.list.classList.toggle('hidden', rows.length === 0); els.empty.classList.toggle('hidden', rows.length !== 0);
  }

  async function updateDelivery(orderId, status, payment) {
    const card = els.list.querySelector(`[data-order-id="${CSS.escape(orderId)}"]`);
    if (card) card.classList.add('is-busy');
    try {
      const response = await Caixa.authenticatedFetch(Caixa.operationPath(`entregas/${encodeURIComponent(orderId)}`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delivery_status: status, delivery_courier: operatorName(), payment_method: payment || null }),
      });
      const payload = await Caixa.json(response);
      if (!response.ok) throw new Error(payload.error || 'request_failed');
      Caixa.showToast(status === 'delivered' ? 'Entrega concluída e registrada.' : status === 'dispatched' ? 'Entrega iniciada.' : 'Entrega atribuída a você.');
      await loadDeliveries();
    } catch (failure) {
      if (failure instanceof Error && failure.message === 'invalid_session') return;
      Caixa.showToast('Não foi possível atualizar a entrega. Tente novamente.');
      if (card) card.classList.remove('is-busy');
    }
  }

  async function loadDeliveries() {
    if (!Caixa.isPartner() || !Caixa.canModule('entregas')) return;
    if (state.request) state.request.abort(); state.request = new AbortController();
    els.loading.classList.remove('hidden'); els.error.classList.add('hidden'); els.empty.classList.add('hidden'); els.list.classList.add('hidden');
    try {
      const response = await Caixa.authenticatedFetch(Caixa.operationPath('operacao/entregas'), { signal: state.request.signal });
      const payload = await Caixa.json(response); if (!response.ok) throw new Error(payload.error || 'request_failed');
      state.rows = Array.isArray(payload.rows) ? payload.rows : [];
      els.pending.textContent = payload.summary?.preparing ?? 0; els.dispatched.textContent = payload.summary?.dispatched ?? 0; els.delivered.textContent = payload.summary?.delivered ?? 0;
      if (state.filter === 'dispatched' && !payload.summary?.dispatched && payload.summary?.preparing) selectFilter('pending'); else render();
    } catch (failure) {
      if (failure instanceof DOMException && failure.name === 'AbortError') return;
      if (failure instanceof Error && failure.message === 'invalid_session') return;
      els.error.classList.remove('hidden');
    } finally { els.loading.classList.add('hidden'); state.request = null; }
  }

  document.querySelectorAll('[data-delivery-filter]').forEach(function (button) { button.addEventListener('click', function () { selectFilter(button.dataset.deliveryFilter); }); });
  els.search.addEventListener('input', function () { state.query = els.search.value; render(); });
  document.getElementById('deliveries-refresh').addEventListener('click', loadDeliveries);
  document.getElementById('deliveries-retry').addEventListener('click', loadDeliveries);
  els.list.addEventListener('click', function (event) {
    const target = event.target.closest('[data-delivery-action]'); if (!target || target.disabled) return;
    const card = target.closest('[data-order-id]'); if (!card) return;
    const action = target.dataset.deliveryAction; const id = card.dataset.orderId;
    if (action === 'route') window.open(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(card.dataset.address)}`, '_blank', 'noopener');
    else if (action === 'payment') card.querySelector('.delivery-payment-choices').classList.toggle('hidden');
    else if (action === 'deliver') void updateDelivery(id, 'delivered', target.dataset.payment);
    else if (action === 'dispatch') void updateDelivery(id, 'dispatched');
    else if (action === 'claim') void updateDelivery(id, 'pending');
  });

  Caixa.loadDeliveries = loadDeliveries;
}());
