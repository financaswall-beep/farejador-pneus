(function () {
  'use strict';

  const Caixa = window.Caixa;
  const elements = Caixa.elements;
  const byId = function (id) { return document.getElementById(id); };
  const ui = {
    search: byId('checkout-search-input'),
    searchClear: byId('checkout-search-clear'),
    typeButtons: Array.from(document.querySelectorAll('[data-catalog-type]')),
    loading: byId('catalog-loading'),
    error: byId('catalog-error'),
    empty: byId('catalog-empty'),
    list: byId('catalog-list'),
    retry: byId('catalog-retry'),
    customerButton: byId('checkout-customer-button'),
    customerForm: byId('checkout-customer-form'),
    customerNameInput: byId('checkout-customer-name'),
    customerPhoneInput: byId('checkout-customer-phone'),
    customerLabel: byId('checkout-cart-title'),
    itemsLabel: byId('checkout-items-label'),
    cartCount: byId('checkout-cart-count'),
    total: byId('checkout-total'),
    paymentButtons: Array.from(document.querySelectorAll('[data-payment]')),
    reviewButton: byId('checkout-review-button'),
    reviewContent: byId('checkout-review-content'),
    confirmButton: byId('checkout-confirm-button'),
    submitError: byId('checkout-submit-error'),
  };
  const checkout = {
    type: 'tire',
    products: [],
    cart: new Map(),
    payment: 'pix',
    customerName: 'Cliente Balcão',
    customerPhone: '',
    searchTimer: 0,
    request: null,
    idempotencyKey: null,
    busy: false,
  };

  const catalogView = Caixa.createCheckoutCatalogView(checkout, ui, changeQuantity);
  const productTitle = catalogView.productTitle;
  const renderCatalog = catalogView.renderCatalog;
  const setCatalogState = catalogView.setCatalogState;

  async function loadCatalog() {
    if (!Caixa.token()) return;
    if (checkout.request) checkout.request.abort();
    const controller = new AbortController();
    checkout.request = controller;
    setCatalogState('loading');
    const params = new URLSearchParams({ type: checkout.type });
    const search = ui.search.value.trim();
    if (search) params.set('search', search);
    try {
      const response = await Caixa.authenticatedFetch('/api/caixa/catalogo?' + params.toString(), {
        signal: controller.signal,
      });
      const payload = await Caixa.json(response);
      if (!response.ok) throw new Error(payload.error || 'request_failed');
      renderCatalog(Array.isArray(payload.products) ? payload.products : []);
    } catch (failure) {
      if (failure instanceof DOMException && failure.name === 'AbortError') return;
      if (failure instanceof Error && failure.message === 'invalid_session') return;
      setCatalogState('error');
    } finally {
      if (checkout.request === controller) checkout.request = null;
    }
  }

  function changeQuantity(product, delta) {
    const current = checkout.cart.get(product.product_id)?.quantity || 0;
    const maximum = product.product_type === 'tire' ? Number(product.stock_quantity || 0) : 50;
    const next = Math.max(0, Math.min(maximum, current + delta));
    if (delta > 0 && next === current) {
      Caixa.showToast('Não há mais unidades disponíveis deste item.');
      return;
    }
    if (next === 0) checkout.cart.delete(product.product_id);
    else checkout.cart.set(product.product_id, { product: product, quantity: next });
    checkout.idempotencyKey = null;
    renderCatalog(checkout.products);
    renderCart();
  }

  function cartTotals() {
    let quantity = 0;
    let total = 0;
    checkout.cart.forEach(function (line) {
      quantity += line.quantity;
      total += Number(line.product.price_amount || 0) * line.quantity;
    });
    return { quantity: quantity, total: Math.round(total * 100) / 100 };
  }

  function renderCart() {
    const totals = cartTotals();
    ui.cartCount.textContent = String(totals.quantity);
    ui.cartCount.classList.toggle('hidden', totals.quantity === 0);
    const customerDisplay = checkout.customerName === 'Cliente Balcão'
      ? 'Balcão' : (checkout.customerName || 'Balcão');
    ui.customerLabel.textContent = 'Cliente: ' + customerDisplay;
    ui.itemsLabel.textContent = totals.quantity === 0
      ? 'Carrinho vazio'
      : totals.quantity + (totals.quantity === 1 ? ' item' : ' itens');
    ui.total.textContent = Caixa.currency.format(totals.total);
    ui.reviewButton.disabled = totals.quantity === 0 || checkout.busy;
  }

  function paymentLabel(value) {
    if (value === 'cartao') return 'Cartão';
    if (value === 'dinheiro') return 'Dinheiro';
    return 'Pix';
  }

  function openCustomer() {
    ui.customerNameInput.value = ['Balcão', 'Cliente Balcão'].includes(checkout.customerName)
      ? '' : checkout.customerName;
    ui.customerPhoneInput.value = checkout.customerPhone;
    elements.customerModal.classList.remove('hidden');
    window.setTimeout(function () { ui.customerNameInput.focus(); }, 20);
  }

  function closeCustomer() {
    elements.customerModal.classList.add('hidden');
  }

  function reviewRow(line) {
    const row = document.createElement('div');
    const copy = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = line.quantity + '× ' + productTitle(line.product);
    const description = document.createElement('small');
    description.textContent = line.product.product_name;
    copy.append(name, description);
    const amount = document.createElement('b');
    amount.textContent = Caixa.currency.format(Number(line.product.price_amount || 0) * line.quantity);
    row.append(copy, amount);
    return row;
  }

  function openReview() {
    if (checkout.cart.size === 0) return;
    ui.submitError.textContent = '';
    ui.reviewContent.replaceChildren();
    const items = document.createElement('div');
    items.className = 'checkout-review-items';
    checkout.cart.forEach(function (line) { items.appendChild(reviewRow(line)); });
    const meta = document.createElement('dl');
    meta.className = 'checkout-review-meta';
    const reviewCustomer = checkout.customerName === 'Cliente Balcão'
      ? 'Balcão' : checkout.customerName;
    [['Cliente', reviewCustomer], ['Pagamento', paymentLabel(checkout.payment)]].forEach(function (pair) {
      const row = document.createElement('div');
      const term = document.createElement('dt');
      term.textContent = pair[0];
      const detail = document.createElement('dd');
      detail.textContent = pair[1];
      row.append(term, detail);
      meta.appendChild(row);
    });
    const total = document.createElement('div');
    total.className = 'checkout-review-total';
    const label = document.createElement('span');
    label.textContent = 'Total da venda';
    const amount = document.createElement('strong');
    amount.textContent = Caixa.currency.format(cartTotals().total);
    total.append(label, amount);
    ui.reviewContent.append(items, meta, total);
    elements.checkoutReviewModal.classList.remove('hidden');
  }

  function closeReview() {
    if (!checkout.busy) elements.checkoutReviewModal.classList.add('hidden');
  }

  function newIdempotencyKey() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return 'caixa-' + window.crypto.randomUUID();
    }
    return 'caixa-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  function submitErrorMessage(code) {
    if (code === 'caixa_finance_not_ready') return 'Financeiro central indisponível. Nada foi vendido e o estoque não foi alterado.';
    if (code === 'walkin_stock_insufficient') return 'O estoque mudou e não há quantidade suficiente. Revise o carrinho.';
    if (code === 'catalog_price_changed') return 'O preço mudou. Atualizamos o catálogo para você revisar.';
    if (code === 'catalog_price_missing') return 'Um item ficou sem preço e não pode ser vendido.';
    if (code === 'walkin_cost_missing') return 'O custo deste pneu ainda não foi apurado no estoque.';
    if (code === 'walkin_stock_ambiguous') return 'O estoque deste item precisa ser conferido antes da venda.';
    if (code === 'walkin_product_not_sellable') return 'Um item não está mais disponível para venda.';
    return 'Não foi possível concluir. Nenhuma baixa foi feita; tente novamente.';
  }

  async function confirmSale() {
    if (checkout.busy || checkout.cart.size === 0) return;
    checkout.busy = true;
    checkout.idempotencyKey = checkout.idempotencyKey || newIdempotencyKey();
    ui.submitError.textContent = '';
    ui.confirmButton.disabled = true;
    ui.confirmButton.textContent = 'REGISTRANDO…';
    renderCart();
    const body = {
      customer_name: checkout.customerName,
      customer_phone: checkout.customerPhone || null,
      payment_method: checkout.payment,
      idempotency_key: checkout.idempotencyKey,
      items: Array.from(checkout.cart.values()).map(function (line) {
        return { product_id: line.product.product_id, quantity: line.quantity };
      }),
    };
    try {
      const response = await Caixa.authenticatedFetch('/api/caixa/vendas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await Caixa.json(response);
      if (!response.ok) throw new Error(payload.error || 'request_failed');
      checkout.cart.clear();
      checkout.idempotencyKey = null;
      elements.checkoutReviewModal.classList.add('hidden');
      renderCart();
      await loadCatalog();
      void Caixa.loadSales();
      if (payload.receipt) {
        elements.receiptModal.classList.remove('hidden');
        Caixa.renderReceipt(payload.receipt);
      }
      Caixa.showToast('Venda registrada, estoque baixado e Financeiro atualizado.');
    } catch (failure) {
      if (failure instanceof Error && failure.message === 'invalid_session') return;
      const code = failure instanceof Error ? failure.message : 'request_failed';
      ui.submitError.textContent = submitErrorMessage(code);
      if (code !== 'request_failed') void loadCatalog();
    } finally {
      checkout.busy = false;
      ui.confirmButton.disabled = false;
      ui.confirmButton.textContent = 'CONFIRMAR VENDA';
      renderCart();
    }
  }

  Object.assign(Caixa, { loadCatalog: loadCatalog });

  ui.search.addEventListener('input', function () {
    ui.searchClear.classList.toggle('hidden', !ui.search.value);
    window.clearTimeout(checkout.searchTimer);
    checkout.searchTimer = window.setTimeout(function () { void loadCatalog(); }, 300);
  });
  ui.searchClear.addEventListener('click', function () {
    ui.search.value = '';
    ui.searchClear.classList.add('hidden');
    ui.search.focus();
    void loadCatalog();
  });
  ui.typeButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      checkout.type = button.dataset.catalogType;
      ui.typeButtons.forEach(function (item) {
        const active = item === button;
        item.classList.toggle('active', active);
        item.setAttribute('aria-pressed', String(active));
      });
      void loadCatalog();
    });
  });
  ui.retry.addEventListener('click', function () { void loadCatalog(); });
  ui.customerButton.addEventListener('click', openCustomer);
  ui.customerForm.addEventListener('submit', function (event) {
    event.preventDefault();
    checkout.customerName = ui.customerNameInput.value.trim() || 'Cliente Balcão';
    checkout.customerPhone = ui.customerPhoneInput.value.trim();
    checkout.idempotencyKey = null;
    closeCustomer();
    renderCart();
  });
  document.querySelectorAll('[data-close-customer]').forEach(function (button) {
    button.addEventListener('click', closeCustomer);
  });
  ui.paymentButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      checkout.payment = button.dataset.payment;
      checkout.idempotencyKey = null;
      ui.paymentButtons.forEach(function (item) {
        const active = item === button;
        item.classList.toggle('active', active);
        item.setAttribute('aria-checked', String(active));
      });
    });
  });
  ui.reviewButton.addEventListener('click', openReview);
  document.querySelectorAll('[data-close-checkout]').forEach(function (button) {
    button.addEventListener('click', closeReview);
  });
  ui.confirmButton.addEventListener('click', function () { void confirmSale(); });
  renderCart();
}());
