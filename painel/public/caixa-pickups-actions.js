(function () {
  'use strict';
  const Caixa = window.Caixa;
  const P = Caixa && Caixa.Pickups;
  if (!P) return;
  const elements = P.elements;
  const state = P.state;

  function errorMessage(error) {
    const code = error && error.message;
    if (code === 'pickup_already_retrieved') return 'Esta retirada já foi finalizada.';
    if (code === 'reserva_insuficiente') return 'A reserva de estoque não está íntegra. Nada foi baixado.';
    if (code === 'pickup_not_found') return 'Esta retirada não está mais disponível. Atualize a fila.';
    if (error && error.status === 403) return 'Seu usuário não tem permissão para operar Retiradas.';
    return 'Não foi possível concluir a operação. Nada foi alterado.';
  }
  async function api(path, options) {
    const response = await Caixa.authenticatedFetch(path, options);
    const payload = await Caixa.json(response);
    if (!response.ok) {
      const failure = new Error(payload.error || 'request_failed');
      failure.status = response.status;
      throw failure;
    }
    return payload;
  }
  function basePath() { return Caixa.operationPath('retiradas', '/api/caixa/retiradas'); }
  async function loadPickups() {
    if (!Caixa.token() || !Caixa.canModule('retiradas')) return;
    if (state.request) state.request.abort();
    const controller = new AbortController();
    state.request = controller; P.setStateView('loading');
    try {
      const payload = await api(basePath(), { signal: controller.signal });
      state.rows = Array.isArray(payload.rows) ? payload.rows : [];
      state.serviceCatalog = Array.isArray(payload.service_catalog) ? payload.service_catalog : [];
      state.rows.forEach(function (row) {
        if (!state.payments[row.order_id]) state.payments[row.order_id] = P.normalizedPayment(row.payment_method);
        state.services[row.order_id] = Array.isArray(row.pickup_services)
          ? row.pickup_services.map(function (item) { return Object.assign({}, item); }) : [];
      });
      if (state.selectedId && !P.selected()) P.closeSheet();
      P.renderList();
      if (!elements.sheet.classList.contains('hidden')) P.renderSheet();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (error instanceof Error && error.message === 'invalid_session') return;
      P.setStateView('error');
    } finally {
      if (state.request === controller) state.request = null;
    }
  }
  async function saveStage(stage) {
    const row = P.selected();
    if (!row || state.saving) return;
    state.saving = true; elements.sheetError.textContent = ''; P.renderSheet();
    try {
      await api(basePath() + '/' + encodeURIComponent(row.order_id) + '/stage', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage: stage, services: P.draftServices(row) }),
      });
      Caixa.showToast('Etapa da retirada atualizada.');
      await loadPickups();
    } catch (error) {
      elements.sheetError.textContent = errorMessage(error);
    } finally {
      state.saving = false; P.renderSheet();
    }
  }
  async function completePickup() {
    const row = P.selected();
    if (!row || state.saving) return;
    if (P.draftServices(row).some(function (service) {
      return service.charge_mode === 'charged' && Number(service.amount_cents || 0) <= 0;
    })) {
      elements.sheetError.textContent = 'Informe o valor do serviço cobrado.';
      return;
    }
    state.saving = true; elements.sheetError.textContent = ''; P.renderSheet();
    try {
      await api(basePath() + '/' + encodeURIComponent(row.order_id), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payment_method: state.payments[row.order_id] || 'Pix', services: P.draftServices(row),
        }),
      });
      Caixa.showToast('Retirada concluída. Estoque e caixa confirmados juntos.');
      await loadPickups(); P.closeSheet();
    } catch (error) {
      elements.sheetError.textContent = errorMessage(error);
    } finally {
      state.saving = false;
      if (!elements.sheet.classList.contains('hidden')) P.renderSheet();
    }
  }
  async function cancelPickup(reason) {
    const row = P.selected();
    if (!row || state.saving) return;
    state.saving = true; elements.sheetError.textContent = '';
    try {
      await api(basePath() + '/' + encodeURIComponent(row.order_id), {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason }),
      });
      Caixa.showToast('Pedido cancelado. A reserva foi liberada sem lançar caixa.');
      await loadPickups(); P.closeSheet();
    } catch (error) {
      elements.sheetError.textContent = errorMessage(error);
    } finally {
      state.saving = false;
      if (!elements.sheet.classList.contains('hidden')) P.renderSheet();
    }
  }

  elements.list.addEventListener('click', function (event) {
    const button = event.target.closest('[data-open-pickup]');
    if (button) P.openSelected(button.dataset.openPickup || '');
  });
  elements.search.addEventListener('input', function () {
    state.search = elements.search.value; P.renderList();
  });
  elements.panel.querySelector('.pickups-filters').addEventListener('click', function (event) {
    const button = event.target.closest('[data-pickup-filter]');
    if (!button) return;
    state.filter = button.dataset.pickupFilter || 'all';
    elements.panel.querySelectorAll('[data-pickup-filter]').forEach(function (item) {
      const active = item === button;
      item.classList.toggle('active', active); item.setAttribute('aria-pressed', String(active));
    });
    P.renderList();
  });
  elements.refresh.addEventListener('click', function () { void loadPickups(); });
  elements.retry.addEventListener('click', function () { void loadPickups(); });
  document.querySelectorAll('[data-close-pickup]').forEach(function (button) {
    button.addEventListener('click', P.closeSheet);
  });
  document.querySelectorAll('[data-pickup-payment]').forEach(function (button) {
    button.addEventListener('click', function () {
      const row = P.selected();
      if (!row || state.saving || P.pickupStage(row) === 'completed') return;
      state.payments[row.order_id] = button.dataset.pickupPayment || 'Pix';
      P.renderPayment(row, false);
    });
  });
  elements.addService.addEventListener('click', function () {
    const row = P.selected();
    if (!row || state.saving || P.pickupStage(row) === 'completed') return;
    const used = new Set(P.draftServices(row).map(function (item) { return item.code; }));
    const next = state.serviceCatalog.find(function (item) { return !used.has(item.code); });
    if (next) P.setServices(row, P.draftServices(row).concat([
      { code: next.code, charge_mode: 'courtesy', amount_cents: 0 },
    ]));
  });
  elements.stageAction.addEventListener('click', function () {
    const row = P.selected();
    if (row) void saveStage(P.pickupStage(row) === 'waiting' ? 'arrived' : 'installing');
  });
  elements.backStage.addEventListener('click', function () {
    const row = P.selected();
    if (row) void saveStage(P.pickupStage(row) === 'installing' ? 'arrived' : 'waiting');
  });
  elements.completeAction.addEventListener('click', function () { void completePickup(); });
  elements.cancelOpen.addEventListener('click', function () {
    elements.cancelReason.value = ''; elements.cancelForm.classList.remove('hidden');
    elements.cancelReason.focus({ preventScroll: true });
  });
  elements.cancelBack.addEventListener('click', function () { elements.cancelForm.classList.add('hidden'); });
  elements.cancelForm.addEventListener('submit', function (event) {
    event.preventDefault();
    const reason = elements.cancelReason.value.trim();
    if (!reason) return void (elements.sheetError.textContent = 'Informe o motivo do cancelamento.');
    void cancelPickup(reason);
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !elements.sheet.classList.contains('hidden')) P.closeSheet();
  });
  Object.assign(Caixa, { loadPickups: loadPickups, openPickup: P.openSelected, closePickup: P.closeSheet });
}());
