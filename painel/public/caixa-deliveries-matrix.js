(function () {
  'use strict';

  const Caixa = window.Caixa;
  const selected = new Set();
  const els = {
    summary: document.getElementById('matrix-route-summary'),
    number: document.getElementById('matrix-route-number'),
    started: document.getElementById('matrix-route-started'),
    progressLabel: document.getElementById('matrix-route-progress-label'),
    progressBar: document.getElementById('matrix-route-progress-bar'),
    start: document.getElementById('matrix-route-start'),
    selected: document.getElementById('matrix-route-selected'),
    kmStart: document.getElementById('matrix-route-km-start'),
    open: document.getElementById('matrix-route-open'),
    close: document.getElementById('matrix-route-close'),
    kmEnd: document.getElementById('matrix-route-km-end'),
    fuel: document.getElementById('matrix-route-fuel'),
    receipt: document.getElementById('matrix-route-receipt'),
    receiptStatus: document.getElementById('matrix-route-receipt-status'),
    closeError: document.getElementById('matrix-route-error'),
    closeButton: document.getElementById('matrix-route-close-button'),
    failureModal: document.getElementById('delivery-failure-modal'),
    failureReason: document.getElementById('delivery-failure-reason'),
    failureError: document.getElementById('delivery-failure-error'),
    failureSubmit: document.getElementById('delivery-failure-submit'),
  };
  const state = { route: null, reload: null, failingOrderId: null, busy: false };

  function setBusy(value) {
    state.busy = value;
    els.open.disabled = value || selected.size === 0;
    els.closeButton.disabled = value || Boolean(state.route && state.route.unresolved > 0);
    els.failureSubmit.disabled = value;
  }

  async function api(method, path, body) {
    const options = { method: method, headers: {} };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    const response = await Caixa.authenticatedFetch('/api/caixa/entregas/' + path, options);
    const payload = await Caixa.json(response);
    if (!response.ok) throw new Error(payload.error || 'request_failed');
    return payload;
  }

  function syncSelection() {
    const count = selected.size;
    els.selected.textContent = count
      ? `${count} entrega${count > 1 ? 's' : ''} selecionada${count > 1 ? 's' : ''}`
      : 'Nenhuma entrega selecionada';
    els.open.textContent = count ? `Começar rota · ${count}` : 'Começar rota';
    els.open.disabled = state.busy || count === 0;
  }

  function sync(payload, reload) {
    state.reload = reload;
    state.route = payload.matrix_route || null;
    const queueIds = new Set((payload.rows || []).filter(function (row) {
      return !row.in_route;
    }).map(function (row) { return row.order_id; }));
    [...selected].forEach(function (id) { if (!queueIds.has(id)) selected.delete(id); });
    els.summary.classList.toggle('hidden', !state.route);
    els.start.classList.toggle('hidden', Boolean(state.route) || queueIds.size === 0);
    els.close.classList.toggle('hidden', !state.route);
    if (state.route) {
      els.number.textContent = state.route.trip_number || 'Rota em andamento';
      const started = new Date(state.route.started_at);
      els.started.textContent = `Saída às ${started.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
        + (state.route.km_start ? ` · km ${state.route.km_start}` : '');
      els.progressLabel.textContent = `${state.route.completed}/${state.route.total}`;
      const percentage = state.route.total
        ? Math.round((state.route.completed / state.route.total) * 100) : 0;
      els.progressBar.style.width = `${percentage}%`;
      els.closeButton.disabled = state.busy || state.route.unresolved > 0;
    }
    syncSelection();
  }

  function matchesFilter(row, filter) {
    if (filter === 'pending') return !row.in_route && row.delivery_status === 'pending';
    if (filter === 'dispatched') {
      return row.in_route && (row.delivery_status === 'pending' || row.delivery_status === 'dispatched');
    }
    return row.in_route && row.delivery_status === 'delivered';
  }

  function contactLink(label, href, icon) {
    const link = document.createElement('a');
    link.href = href; link.className = 'delivery-contact'; link.setAttribute('aria-label', label);
    if (href.startsWith('http')) { link.target = '_blank'; link.rel = 'noopener'; }
    link.appendChild(Caixa.createSvg([{ d: icon }]));
    return link;
  }

  function renderActions(row, card, helpers) {
    const actions = document.createElement('div'); actions.className = 'delivery-actions';
    if (!row.in_route) {
      const active = selected.has(row.order_id);
      const button = helpers.actionButton(active ? 'Entrega selecionada' : 'Selecionar entrega', 'select', true);
      button.classList.toggle('is-selected', active); actions.appendChild(button);
    } else if (row.delivery_status === 'pending') {
      actions.append(
        helpers.actionButton('Sair para entrega', 'dispatch', true),
        helpers.actionButton('Não entreguei', 'fail', false),
      );
    } else if (row.delivery_status === 'dispatched') {
      actions.append(...helpers.navigationLinks(card.dataset.address));
      if (row.customer_phone) {
        actions.append(
          contactLink('Ligar para o cliente', helpers.phoneHref(row.customer_phone, false), 'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.9a2 2 0 0 1-.5 2.1L8 10a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c1 .3 1.9.6 2.9.7a2 2 0 0 1 1.7 2Z'),
          contactLink('Abrir WhatsApp', helpers.phoneHref(row.customer_phone, true), 'M21 11.5a8.4 8.4 0 0 1-9 8.4 8.8 8.8 0 0 1-3.7-.9L3 21l1.8-5a8.6 8.6 0 1 1 16.2-4.5Z'),
        );
      }
      actions.append(
        helpers.actionButton('Confirmar entrega', 'payment', false),
        helpers.actionButton('Não entreguei', 'fail', false),
      );
    }
    if (actions.childElementCount) card.appendChild(actions);
  }

  async function updateStatus(orderId, status, payment) {
    setBusy(true);
    try {
      await api('POST', 'status', { order_id: orderId, status: status, payment_method: payment || null });
      Caixa.showToast(status === 'delivered' ? 'Entrega confirmada.' : 'Entrega saiu para a rota.');
      await state.reload();
    } catch (error) {
      if (error.message !== 'invalid_session') Caixa.showToast('Não foi possível atualizar a entrega.');
    } finally { setBusy(false); }
  }

  function openFailure(orderId) {
    state.failingOrderId = orderId; els.failureReason.value = ''; els.failureError.textContent = '';
    els.failureModal.classList.remove('hidden'); els.failureReason.focus();
  }

  function closeFailure() {
    state.failingOrderId = null; els.failureModal.classList.add('hidden');
  }

  async function submitFailure() {
    const reason = els.failureReason.value.trim();
    if (!reason) { els.failureError.textContent = 'Informe o motivo.'; return; }
    setBusy(true);
    try {
      await api('POST', 'nao-entregue', { order_id: state.failingOrderId, reason: reason });
      closeFailure(); Caixa.showToast('Ocorrência registrada para o escritório.'); await state.reload();
    } catch (error) { els.failureError.textContent = 'Não foi possível registrar.'; }
    finally { setBusy(false); }
  }

  async function handleAction(action, target, card) {
    const id = card.dataset.orderId;
    if (action === 'select') {
      if (selected.has(id)) selected.delete(id); else selected.add(id);
      target.textContent = selected.has(id) ? 'Entrega selecionada' : 'Selecionar entrega';
      target.classList.toggle('is-selected', selected.has(id)); syncSelection(); return true;
    }
    if (action === 'payment') card.querySelector('.delivery-payment-choices').classList.toggle('hidden');
    else if (action === 'deliver') await updateStatus(id, 'delivered', target.dataset.payment);
    else if (action === 'dispatch') await updateStatus(id, 'dispatched');
    else if (action === 'fail') openFailure(id);
    else return false;
    return true;
  }

  async function openRoute() {
    if (!selected.size) return;
    setBusy(true);
    try {
      await api('POST', 'rota/abrir', {
        km_start: els.kmStart.value === '' ? null : Number(els.kmStart.value),
        order_ids: [...selected],
      });
      selected.clear(); els.kmStart.value = ''; Caixa.showToast('Rota iniciada. Boa viagem!');
      document.querySelector('[data-delivery-filter="dispatched"]').click();
      await state.reload();
    } catch (error) { Caixa.showToast('Não foi possível iniciar a rota.'); }
    finally { setBusy(false); }
  }

  async function uploadReceipt() {
    const file = els.receipt.files && els.receipt.files[0]; if (!file) return;
    els.receiptStatus.textContent = 'Enviando comprovante…';
    try {
      const response = await Caixa.authenticatedFetch('/api/caixa/entregas/rota/comprovante', {
        method: 'POST', headers: { 'Content-Type': file.type || 'image/jpeg' }, body: file,
      });
      const payload = await Caixa.json(response); if (!response.ok) throw new Error(payload.error || 'upload');
      els.receiptStatus.textContent = payload.duplicate ? 'Comprovante já anexado.' : 'Comprovante enviado.';
    } catch (error) {
      els.receiptStatus.textContent = error.message === 'receipt_exact_duplicate'
        ? 'Este arquivo já foi usado em outro comprovante.' : 'Não foi possível enviar a foto.';
    }
    finally { els.receipt.value = ''; }
  }

  async function closeRoute() {
    setBusy(true); els.closeError.textContent = '';
    try {
      await api('POST', 'rota/fechar', {
        km_end: els.kmEnd.value === '' ? null : Number(els.kmEnd.value),
        fuel_spent: els.fuel.value === '' ? null : Number(els.fuel.value),
      });
      els.kmEnd.value = ''; els.fuel.value = ''; els.receiptStatus.textContent = '';
      Caixa.showToast('Rota encerrada e registrada.'); await state.reload();
    } catch (error) {
      els.closeError.textContent = error.message === 'trip_has_unresolved_deliveries'
        ? 'Finalize ou informe todas as paradas.' : 'Não foi possível encerrar a rota.';
    } finally { setBusy(false); }
  }

  els.open.addEventListener('click', openRoute);
  els.receipt.addEventListener('change', uploadReceipt);
  els.closeButton.addEventListener('click', closeRoute);
  els.failureSubmit.addEventListener('click', submitFailure);
  document.querySelectorAll('[data-close-delivery-failure]').forEach(function (button) {
    button.addEventListener('click', closeFailure);
  });

  Caixa.matrixDeliveries = {
    sync: sync,
    matchesFilter: matchesFilter,
    renderActions: renderActions,
    handleAction: handleAction,
    photoPath: function (id) { return `/api/caixa/entregas/fotos/${encodeURIComponent(id)}`; },
  };
}());
