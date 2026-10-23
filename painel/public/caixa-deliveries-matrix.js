(function () {
  'use strict';
  const C = window.Caixa;
  const ui = C.createMatrixDeliveryView();
  const state = { rows: [], selected: new Set(), route: null, view: 'prepare', reload: null,
    paymentOrderId: null, paymentMethod: null, received: false, failingOrderId: null,
    query: '', busy: false, loading: false, error: '', notice: '', session: '', generation: 0 };
  function paint() { if (!C.isPartner()) ui.render(state); }
  function clearPayment() { state.paymentOrderId = null; state.paymentMethod = null; state.received = false; }
  function go(view) {
    if (state.busy) return;
    if (['route', 'close'].includes(view) && !state.route) view = 'prepare';
    if (view === 'close' && state.route.unresolved > 0) return;
    if (view !== 'payment') clearPayment();
    state.view = view; state.error = ''; state.notice = ''; paint(); ui.focus();
  }
  const actions = C.createMatrixDeliveryActions(state, ui, paint);
  function reset() {
    state.generation++; actions.closeFailure(true); state.selected.clear(); clearPayment();
    Object.assign(state, { rows: [], route: null, view: 'prepare', query: '', busy: false, loading: false, error: '', notice: '' });
    ui.root.classList.add('hidden'); ui.byId('deliveries-panel').classList.remove('matrix-delivery-active');
    for (const id of ['matrix-route-km-start', 'matrix-route-km-end', 'matrix-route-fuel', 'matrix-route-receipt', 'mdf-search']) ui.byId(id).value = '';
    ui.byId('matrix-route-receipt-status').textContent = '';
  }
  function sync(payload, reload) {
    const session = C.sessionFingerprint(); if (state.session !== session) { reset(); state.session = session; }
    const previousRoute = state.route?.trip_id;
    state.loading = false; state.error = '';
    state.rows = Array.isArray(payload.rows) ? payload.rows : []; state.route = payload.matrix_route || null; state.reload = reload;
    const ids = new Set(state.rows.filter(row => !row.in_route && row.delivery_status === 'pending').map(row => row.order_id));
    [...state.selected].forEach(id => { if (!ids.has(id)) state.selected.delete(id); });
    if (previousRoute !== state.route?.trip_id) {
      clearPayment(); actions.closeFailure(true);
      for (const id of ['matrix-route-km-end', 'matrix-route-fuel']) ui.byId(id).value = '';
      ui.byId('matrix-route-receipt-status').textContent = ''; state.view = state.route ? 'route' : 'prepare';
    }
    if (!state.route && state.view !== 'prepare') state.view = 'prepare';
    if (state.paymentOrderId && !state.rows.some(row => row.order_id === state.paymentOrderId && row.in_route && row.delivery_status === 'dispatched')) {
      clearPayment(); state.view = state.route ? 'route' : 'prepare'; state.error = 'O pedido foi atualizado. Confira a rota antes de continuar.';
    }
    paint();
  }
  async function handleAction(action, target, card) {
    if (state.busy || state.loading || C.isPartner()) return false;
    const id = target?.dataset.orderId || card?.dataset.orderId; const row = state.rows.find(item => item.order_id === id);
    if (action === 'select') {
      if (state.route || !row || row.in_route || row.delivery_status !== 'pending') return false;
      if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id); paint();
    } else if (action === 'payment') {
      if (!row?.in_route || row.delivery_status !== 'dispatched') return false;
      clearPayment(); state.paymentOrderId = id; go('payment');
    } else if (action === 'dispatch') await actions.dispatch(id);
    else if (action === 'fail') actions.openFailure(id);
    else if (action === 'prepare') go('prepare');
    else if (action === 'route') go('route');
    else if (action === 'close') go('close');
    else if (action === 'back') go(state.view === 'route' ? 'prepare' : 'route');
    else if (action === 'refresh') await C.loadDeliveries();
    else return false;
    return true;
  }
  ui.root.addEventListener('click', event => {
    const target = event.target.closest('[data-mdf-action]');
    if (target && !target.disabled) void handleAction(target.dataset.mdfAction, target, target.closest('[data-order-id]'));
  });
  ui.byId('mdf-search').addEventListener('input', event => { state.query = event.target.value; paint(); });
  ui.root.addEventListener('change', event => {
    if (state.busy) return;
    if (event.target.name === 'mdf-payment') { state.paymentMethod = event.target.value; state.received = false; paint(); }
    else if (event.target.id === 'mdf-received') { state.received = event.target.checked; paint(); }
  });
  function leave() { actions.closeFailure(true); clearPayment(); if (C.isPartner()) reset(); else if (state.view === 'payment') state.view = state.route ? 'route' : 'prepare'; }
  function loading() {
    const session = C.sessionFingerprint(); if (state.session !== session) { reset(); state.session = session; }
    state.loading = true; paint();
  }
  function loadFailed() { state.loading = false; state.error = 'Não consegui atualizar as entregas. Toque em atualizar para tentar novamente.'; paint(); }
  C.matrixDeliveries = {
    sync, render: paint, handleAction, leave, reset, loading, loadFailed,
    matchesFilter: (row, filter) => filter === 'pending' ? !row.in_route && row.delivery_status === 'pending'
      : filter === 'dispatched' ? row.in_route && ['pending', 'dispatched'].includes(row.delivery_status)
        : row.in_route && row.delivery_status === 'delivered',
    renderActions: function () {}, photoPath: id => `/api/caixa/entregas/fotos/${encodeURIComponent(id)}`,
  };
}());
