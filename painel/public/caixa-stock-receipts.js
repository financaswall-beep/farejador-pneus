(function () {
  'use strict';

  const Caixa = window.Caixa;
  const byId = function (id) { return document.getElementById(id); };
  const state = { rows: [], selected: null, key: '', request: 0 };
  const dateTime = new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo',
  });

  function node(tag, value, className) {
    const item = document.createElement(tag);
    if (value != null) item.textContent = value;
    if (className) item.className = className;
    return item;
  }

  function svg(paths) {
    return Caixa.createSvg(paths.map(function (d) { return { d: d }; }));
  }

  function purchaseReference(id) {
    return `Compra #${String(id || '').slice(0, 8).toUpperCase()}`;
  }

  function formatDate(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : dateTime.format(date);
  }

  function expectedUnits(purchase) {
    return (purchase.items || []).reduce(function (sum, item) {
      return sum + Number(item.expected_quantity || 0);
    }, 0);
  }

  function renderList() {
    const list = byId('stock-receipts-list');
    list.replaceChildren();
    state.rows.forEach(function (purchase) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'stock-receipt-card';
      card.dataset.purchaseId = purchase.purchase_id;
      const icon = node('span', null, 'stock-receipt-card-icon');
      icon.appendChild(svg(['m4 7 8-4 8 4-8 4-8-4Z', 'M4 7v10l8 4 8-4V7M12 11v10']));
      const content = node('span', null, 'stock-receipt-card-copy');
      content.append(
        node('strong', purchaseReference(purchase.purchase_id)),
        node('span', purchase.supplier_name || 'Fornecedor não informado'),
        node('small', `${purchase.items.length} ${purchase.items.length === 1 ? 'produto' : 'produtos'} · ${expectedUnits(purchase)} unidades`),
      );
      const side = node('span', null, 'stock-receipt-card-side');
      side.append(node('b', 'Conferir'), svg(['m9 18 6-6-6-6']));
      card.append(icon, content, side);
      list.appendChild(card);
    });
    byId('stock-receipts-loading').classList.add('hidden');
    byId('stock-receipts-error').classList.add('hidden');
    byId('stock-receipts-empty').classList.toggle('hidden', state.rows.length > 0);
    list.classList.toggle('hidden', state.rows.length === 0);
  }

  async function loadReceipts() {
    const request = ++state.request;
    byId('stock-receipts-loading').classList.remove('hidden');
    byId('stock-receipts-error').classList.add('hidden');
    byId('stock-receipts-empty').classList.add('hidden');
    byId('stock-receipts-list').classList.add('hidden');
    try {
      const response = await Caixa.authenticatedFetch(Caixa.operationPath('operacao/compras'));
      const payload = await Caixa.json(response);
      if (!response.ok) throw new Error(payload.error || 'request_failed');
      if (request !== state.request) return;
      state.rows = payload.rows || [];
      renderList();
    } catch (failure) {
      if (failure instanceof Error && failure.message === 'invalid_session') return;
      if (request !== state.request) return;
      byId('stock-receipts-loading').classList.add('hidden');
      byId('stock-receipts-error').classList.remove('hidden');
    }
  }

  function refreshTotals() {
    if (!state.selected) return;
    const expected = expectedUnits(state.selected);
    const received = state.selected.items.reduce(function (sum, item) {
      return sum + Number(item.received_quantity || 0);
    }, 0);
    const difference = received - expected;
    byId('stock-receipt-expected').textContent = String(expected);
    byId('stock-receipt-received').textContent = String(received);
    byId('stock-receipt-difference').textContent = difference > 0 ? `+${difference}` : String(difference);
    byId('stock-receipt-difference').classList.toggle('warning', difference !== 0);
  }

  function createReceiptItem(item, index) {
    const card = node('article', null, 'stock-receipt-item');
    const image = document.createElement('img');
    image.src = '/operacao/catalog-tire.webp';
    image.alt = '';
    const identity = node('div', null, 'stock-receipt-item-copy');
    identity.append(
      node('strong', item.tire_size || item.item_name),
      node('span', item.brand || item.item_name),
      node('small', item.tire_condition ? item.tire_condition.replace('_', '-') : 'Condição não informada'),
    );
    const quantity = node('div', null, 'stock-receipt-quantity');
    quantity.appendChild(node('small', 'Quantidade recebida'));
    const stepper = node('span', null, 'stock-receipt-stepper');
    const minus = node('button', '−');
    minus.type = 'button';
    minus.dataset.receiptIndex = String(index);
    minus.dataset.receiptDelta = '-1';
    minus.setAttribute('aria-label', 'Diminuir quantidade');
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.max = '999999';
    input.inputMode = 'numeric';
    input.value = String(item.received_quantity);
    input.dataset.receiptInput = String(index);
    input.setAttribute('aria-label', `Quantidade recebida de ${item.item_name}`);
    const plus = node('button', '+');
    plus.type = 'button';
    plus.dataset.receiptIndex = String(index);
    plus.dataset.receiptDelta = '1';
    plus.setAttribute('aria-label', 'Aumentar quantidade');
    stepper.append(minus, input, plus);
    quantity.append(stepper, node('small', `Esperado: ${item.expected_quantity}`, 'stock-receipt-expected-label'));
    card.append(image, identity, quantity);
    return card;
  }

  function openDetail(purchase) {
    state.selected = {
      ...purchase,
      items: purchase.items.map(function (item) {
        return { ...item, received_quantity: Number(item.expected_quantity || 0) };
      }),
    };
    state.key = Caixa.stockIdempotencyKey('receipt');
    byId('stock-receipts-title').textContent = 'Conferir compra';
    byId('stock-receipt-reference').textContent = purchaseReference(purchase.purchase_id);
    byId('stock-receipt-supplier').textContent = purchase.supplier_name || 'Fornecedor não informado';
    byId('stock-receipt-date').textContent = formatDate(purchase.purchased_at || purchase.created_at);
    byId('stock-receipt-items').replaceChildren(...state.selected.items.map(createReceiptItem));
    byId('stock-receipt-confirm-check').checked = false;
    byId('stock-receipt-submit').disabled = true;
    byId('stock-receipt-submit-error').textContent = '';
    byId('stock-receipts-list-view').classList.add('hidden');
    byId('stock-receipt-detail-view').classList.remove('hidden');
    refreshTotals();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function closeDetail() {
    state.selected = null;
    byId('stock-receipts-title').textContent = 'Receber compra';
    byId('stock-receipt-detail-view').classList.add('hidden');
    byId('stock-receipts-list-view').classList.remove('hidden');
  }

  function openReceipts() {
    byId('stock-receipts-unit').textContent = Caixa.elements.operationUnitLabel.textContent;
    byId('stock-receipts-operator').textContent = Caixa.elements.operatorLabel.textContent;
    closeDetail();
    Caixa.showTab('stock-receipts');
    void loadReceipts();
  }

  async function submitReceipt() {
    if (!state.selected) return;
    const button = byId('stock-receipt-submit');
    button.disabled = true;
    byId('stock-receipt-submit-error').textContent = '';
    try {
      const response = await Caixa.authenticatedFetch(Caixa.operationPath(
        `operacao/compras/${encodeURIComponent(state.selected.purchase_id)}/receber`,
      ), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idempotency_key: state.key,
          items: state.selected.items.map(function (item) {
            return { item_id: item.item_id, received_quantity: Number(item.received_quantity) };
          }),
        }),
      });
      const payload = await Caixa.json(response);
      if (!response.ok) throw new Error(payload.error || 'request_failed');
      Caixa.showToast(payload.has_divergence
        ? 'Recebimento concluído com diferença registrada.' : 'Compra recebida e estoque atualizado.');
      Caixa.showTab('stock');
      void Caixa.loadStock();
    } catch (failure) {
      if (failure instanceof Error && failure.message === 'invalid_session') return;
      const code = failure instanceof Error ? failure.message : '';
      byId('stock-receipt-submit-error').textContent = code === 'purchase_already_received'
        ? 'Esta compra já foi recebida por outra pessoa.'
        : 'Não foi possível confirmar. Tente novamente.';
      button.disabled = !byId('stock-receipt-confirm-check').checked;
    }
  }

  byId('stock-receipts-open').addEventListener('click', openReceipts);
  byId('stock-receipts-retry').addEventListener('click', function () { void loadReceipts(); });
  byId('stock-receipts-list').addEventListener('click', function (event) {
    const card = event.target.closest('[data-purchase-id]');
    const purchase = card && state.rows.find(function (row) { return row.purchase_id === card.dataset.purchaseId; });
    if (purchase) openDetail(purchase);
  });
  byId('stock-receipts-back').addEventListener('click', function () {
    if (state.selected) closeDetail(); else Caixa.showTab('stock');
  });
  byId('stock-receipt-items').addEventListener('click', function (event) {
    const button = event.target.closest('[data-receipt-delta]');
    if (!button || !state.selected) return;
    const index = Number(button.dataset.receiptIndex);
    const item = state.selected.items[index];
    item.received_quantity = Math.max(0, Number(item.received_quantity) + Number(button.dataset.receiptDelta));
    byId('stock-receipt-items').querySelector(`[data-receipt-input="${index}"]`).value = item.received_quantity;
    refreshTotals();
  });
  byId('stock-receipt-items').addEventListener('input', function (event) {
    if (!event.target.matches('[data-receipt-input]') || !state.selected) return;
    const index = Number(event.target.dataset.receiptInput);
    state.selected.items[index].received_quantity = Math.max(0, Math.min(999999, Number(event.target.value || 0)));
    refreshTotals();
  });
  byId('stock-receipt-confirm-check').addEventListener('change', function (event) {
    byId('stock-receipt-submit').disabled = !event.target.checked;
  });
  byId('stock-receipt-submit').addEventListener('click', function () { void submitReceipt(); });

  Caixa.loadPurchaseReceipts = loadReceipts;
}());
