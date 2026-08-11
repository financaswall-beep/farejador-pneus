(function () {
  'use strict';

  const Caixa = window.Caixa;
  const byId = function (id) { return document.getElementById(id); };
  const state = Caixa.stockState = {
    rows: [], query: '', type: 'produto', request: 0, registrationKey: '', countKey: '',
  };
  const registerModal = byId('stock-register-modal');
  const countModal = byId('stock-count-modal');
  const registerForm = byId('stock-register-form');
  const countForm = byId('stock-count-form');

  function idempotencyKey(prefix) {
    const random = window.crypto && typeof window.crypto.randomUUID === 'function'
      ? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `${prefix}-${random}`;
  }

  function nullable(value) {
    const text = String(value || '').trim();
    return text || null;
  }

  function optionalNumber(value) {
    return value === '' ? null : Number(value);
  }

  function setLoading() {
    byId('stock-loading').classList.remove('hidden');
    byId('stock-error').classList.add('hidden');
    byId('stock-empty').classList.add('hidden');
    byId('stock-list').classList.add('hidden');
  }

  async function loadStock() {
    if (!Caixa.isPartner() || !Caixa.canModule || !Caixa.canModule('estoque')) return;
    const request = ++state.request;
    setLoading();
    try {
      const response = await Caixa.authenticatedFetch(Caixa.operationPath('operacao/estoque'));
      const payload = await Caixa.json(response);
      if (!response.ok) throw new Error(payload.error || 'request_failed');
      if (request !== state.request) return;
      state.rows = payload.rows || [];
      Caixa.stockView.renderSummary(payload);
      Caixa.stockView.fillCountItems(state.rows);
      Caixa.stockView.renderList();
    } catch (failure) {
      if (failure instanceof Error && failure.message === 'invalid_session') return;
      if (request !== state.request) return;
      byId('stock-loading').classList.add('hidden');
      byId('stock-error').classList.remove('hidden');
    }
  }

  function closeRegister() {
    registerModal.classList.add('hidden');
    byId('stock-register-error').textContent = '';
  }

  function syncRegistrationType() {
    const type = byId('stock-item-type').value;
    document.querySelectorAll('[data-tire-fields]').forEach(function (field) {
      field.classList.toggle('hidden', type !== 'pneu');
    });
    document.querySelectorAll('[data-stock-fields]').forEach(function (field) {
      field.classList.toggle('hidden', type === 'servico');
    });
    ['stock-tire-width', 'stock-tire-aspect', 'stock-tire-rim'].forEach(function (id) {
      byId(id).required = type === 'pneu';
    });
    byId('stock-tire-condition').required = type === 'pneu';
  }

  function openRegister() {
    registerForm.reset();
    state.registrationKey = idempotencyKey('item');
    syncRegistrationType();
    byId('stock-register-error').textContent = '';
    registerModal.classList.remove('hidden');
    byId('stock-item-name').focus({ preventScroll: true });
  }

  function selectedCountRow() {
    const id = byId('stock-count-item').value;
    return state.rows.find(function (row) { return row.stock_id === id; });
  }

  function updateCountSystem() {
    const row = selectedCountRow();
    byId('stock-count-system').textContent = !row || row.quantity_on_hand == null
      ? 'Não informado' : `${row.quantity_on_hand} un.`;
  }

  function closeCount() {
    countModal.classList.add('hidden');
    byId('stock-count-error').textContent = '';
  }

  function openCount(stockId) {
    Caixa.stockView.fillCountItems(state.rows);
    const select = byId('stock-count-item');
    if (!select.options.length) {
      Caixa.showToast('Não há produto controlado disponível para contagem.');
      return;
    }
    countForm.reset();
    state.countKey = idempotencyKey('count');
    if (stockId) select.value = stockId;
    updateCountSystem();
    byId('stock-count-error').textContent = '';
    countModal.classList.remove('hidden');
    byId('stock-count-quantity').focus({ preventScroll: true });
  }

  function registrationPayload() {
    const type = byId('stock-item-type').value;
    const payload = {
      item_type: type,
      item_name: byId('stock-item-name').value.trim(),
      brand: nullable(byId('stock-item-brand').value),
      local_sku: nullable(byId('stock-item-sku').value),
      idempotency_key: state.registrationKey,
    };
    if (type !== 'servico') {
      payload.minimum_quantity = optionalNumber(byId('stock-item-minimum').value);
      payload.shelf_location = nullable(byId('stock-item-shelf').value);
    }
    if (type === 'pneu') {
      payload.tire_width_mm = optionalNumber(byId('stock-tire-width').value);
      payload.tire_aspect_ratio = optionalNumber(byId('stock-tire-aspect').value);
      payload.tire_rim_diameter = optionalNumber(byId('stock-tire-rim').value);
      payload.tire_condition = byId('stock-tire-condition').value;
      payload.tire_position = nullable(byId('stock-tire-position').value);
    }
    return payload;
  }

  async function submitRequest(path, payload, button, errorElement) {
    button.disabled = true;
    errorElement.textContent = '';
    try {
      const response = await Caixa.authenticatedFetch(Caixa.operationPath(path), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await Caixa.json(response);
      if (!response.ok) throw new Error(result.error || 'request_failed');
      return true;
    } catch (failure) {
      if (failure instanceof Error && failure.message === 'invalid_session') return false;
      const code = failure instanceof Error ? failure.message : '';
      errorElement.textContent = code === 'stock_unavailable_for_count'
        ? 'Este item não está disponível para contagem.'
        : 'Não foi possível enviar. Confira os campos e tente novamente.';
      return false;
    } finally {
      button.disabled = false;
    }
  }

  registerForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (!registerForm.reportValidity()) return;
    const ok = await submitRequest(
      'operacao/estoque/cadastros', registrationPayload(),
      byId('stock-register-submit'), byId('stock-register-error'),
    );
    if (!ok) return;
    closeRegister();
    Caixa.showToast('Cadastro enviado para aprovação do dono.');
    void loadStock();
  });

  countForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (!countForm.reportValidity()) return;
    const ok = await submitRequest('operacao/estoque/contagens', {
      stock_id: byId('stock-count-item').value,
      counted_quantity: Number(byId('stock-count-quantity').value),
      reason: byId('stock-count-reason').value,
      idempotency_key: state.countKey,
    }, byId('stock-count-submit'), byId('stock-count-error'));
    if (!ok) return;
    closeCount();
    Caixa.showToast('Contagem enviada. O saldo oficial não foi alterado.');
    void loadStock();
  });

  byId('stock-register-open').addEventListener('click', openRegister);
  byId('stock-count-open').addEventListener('click', function () { openCount(''); });
  byId('stock-item-type').addEventListener('change', syncRegistrationType);
  byId('stock-count-item').addEventListener('change', updateCountSystem);
  byId('stock-retry').addEventListener('click', function () { void loadStock(); });
  document.querySelectorAll('[data-close-stock-register]').forEach(function (button) { button.addEventListener('click', closeRegister); });
  document.querySelectorAll('[data-close-stock-count]').forEach(function (button) { button.addEventListener('click', closeCount); });
  byId('stock-list').addEventListener('click', function (event) {
    const button = event.target.closest('[data-stock-count]');
    if (button) openCount(button.dataset.stockCount || '');
  });
  byId('stock-search-input').addEventListener('input', function (event) {
    state.query = event.target.value.trim();
    byId('stock-search-clear').classList.toggle('hidden', !state.query);
    Caixa.stockView.renderList();
  });
  byId('stock-search-clear').addEventListener('click', function () {
    byId('stock-search-input').value = '';
    state.query = '';
    byId('stock-search-clear').classList.add('hidden');
    Caixa.stockView.renderList();
  });
  document.querySelectorAll('[data-stock-type]').forEach(function (button) {
    button.addEventListener('click', function () {
      state.type = button.dataset.stockType;
      document.querySelectorAll('[data-stock-type]').forEach(function (item) {
        const active = item === button;
        item.classList.toggle('active', active);
        item.setAttribute('aria-pressed', String(active));
      });
      Caixa.stockView.renderList();
    });
  });
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    if (!registerModal.classList.contains('hidden')) closeRegister();
    else if (!countModal.classList.contains('hidden')) closeCount();
  });

  Caixa.loadStock = loadStock;
}());
