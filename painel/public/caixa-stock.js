(function () {
  'use strict';

  const Caixa = window.Caixa;
  const byId = function (id) { return document.getElementById(id); };
  const state = Caixa.stockState = {
    rows: [], query: '', type: 'produto', request: 0, registrationKey: '',
  };
  const registerModal = byId('stock-register-modal');
  const registerForm = byId('stock-register-form');

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
    const isService = type === 'servico';
    const isSupply = type === 'insumo';
    document.querySelectorAll('[data-tire-fields]').forEach(function (field) {
      field.classList.toggle('hidden', type !== 'pneu');
    });
    document.querySelectorAll('[data-stock-fields]').forEach(function (field) {
      field.classList.toggle('hidden', isService);
    });
    document.querySelectorAll('[data-product-fields]').forEach(function (field) {
      field.classList.toggle('hidden', isService);
    });
    ['stock-tire-width', 'stock-tire-aspect', 'stock-tire-rim'].forEach(function (id) {
      byId(id).required = type === 'pneu';
    });
    byId('stock-tire-condition').required = type === 'pneu';
    byId('stock-register-kicker').textContent = isService ? 'Catálogo de serviços' : 'Estoque protegido';
    byId('stock-register-title').textContent = isService ? 'Cadastrar serviço' : 'Cadastrar produto';
    byId('stock-register-notice-title').textContent = isService ? 'Preço protegido' : 'Sem valores financeiros';
    byId('stock-register-notice-copy').textContent = isService
      ? 'Você informa o serviço. O dono define custo e preço antes de liberar para venda.'
      : 'Você informa o produto. O dono confere custo, preço e saldo antes de liberar.';
    byId('stock-item-name-label').textContent = isService ? 'Nome do serviço' : (isSupply ? 'Nome do material' : 'Nome do produto');
    byId('stock-item-name').placeholder = isService
      ? 'Ex.: Troca de pneu' : (isSupply ? 'Ex.: Remendo para câmara' : 'Ex.: Maggion Matrix Plus CG');
    byId('stock-register-submit').textContent = isService
      ? 'Salvar serviço e enviar para aprovação' : 'Salvar produto e enviar para aprovação';
  }

  function openRegister(type) {
    registerForm.reset();
    byId('stock-item-type').value = type === 'servico' ? 'servico' : 'pneu';
    state.registrationKey = idempotencyKey('item');
    syncRegistrationType();
    byId('stock-register-error').textContent = '';
    registerModal.classList.remove('hidden');
    byId('stock-item-name').focus({ preventScroll: true });
  }

  function registrationPayload() {
    const type = byId('stock-item-type').value;
    const payload = {
      item_type: type,
      item_name: byId('stock-item-name').value.trim(),
      brand: type === 'servico' ? null : nullable(byId('stock-item-brand').value),
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

  byId('stock-product-open').addEventListener('click', function () { openRegister('pneu'); });
  byId('stock-service-open').addEventListener('click', function () { openRegister('servico'); });
  byId('stock-count-open').addEventListener('click', function () { Caixa.openStockCount(''); });
  byId('stock-item-type').addEventListener('change', syncRegistrationType);
  byId('stock-retry').addEventListener('click', function () { void loadStock(); });
  document.querySelectorAll('[data-close-stock-register]').forEach(function (button) { button.addEventListener('click', closeRegister); });
  byId('stock-list').addEventListener('click', function (event) {
    const button = event.target.closest('[data-stock-count]');
    if (button) Caixa.openStockCount(button.dataset.stockCount || '');
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
  });

  Object.assign(Caixa, {
    loadStock: loadStock,
    stockIdempotencyKey: idempotencyKey,
    submitStockRequest: submitRequest,
  });
}());
