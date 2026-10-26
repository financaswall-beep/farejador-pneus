(function () {
  'use strict';
  const C = window.Caixa, P = C.Pickups, V = C.pickupMetalView;
  if (!P || !V) return;
  const panel = P.elements.panel, host = V.el('section'); host.id = 'matrix-pickups-metal'; host.hidden = true; panel.appendChild(host);
  const m = { active: false, session: '', epoch: 0, view: 'queue', phase: 'loading', received: false, reason: '', error: '', receipt: null, cancelBack: 'arrival', busy: false };
  const legacy = { list: P.renderList, sheet: P.renderSheet, open: P.openSelected, close: P.closeSheet, state: P.setStateView };
  const allowed = () => !C.isPartner() && !!C.token() && C.canModule('retiradas');
  const valid = () => allowed() && m.active && m.session === C.sessionFingerprint();
  function reset() {
    ++m.epoch; P.state.request?.abort(); P.state.request = null;
    Object.assign(m, { active: false, session: '', view: 'queue', phase: 'loading', received: false, reason: '', error: '', receipt: null, busy: false });
    Object.assign(P.state, { rows: [], selectedId: '', payments: {}, services: {}, serviceCatalog: [], saving: false, search: '', filter: 'all' });
    P.elements.search.value = ''; P.elements.sheetError.textContent = ''; legacy.close(); host.replaceChildren(); host.hidden = true;
  }
  function sync(tab) {
    const session = C.sessionFingerprint();
    if (m.session && m.session !== session) reset();
    const active = tab === 'pickups' && allowed();
    if (m.active && !active) { ++m.epoch; m.view = 'queue'; m.received = false; m.busy = false; P.state.selectedId = ''; legacy.close(); }
    m.session = session; m.active = active; host.hidden = !active;
    if (active) render();
  }
  function navigate(view) {
    m.view = view; m.error = ''; P.elements.sheetError.textContent = '';
    if (view !== 'payment') m.received = false;
    render();
  }
  function open(id) {
    if (C.isPartner()) return legacy.open(id);
    if (!valid() || P.state.saving || m.phase !== 'ready') return;
    P.state.selectedId = id; const row = P.selected(); if (!row) return;
    m.received = false; m.reason = ''; m.receipt = null;
    navigate(({ waiting: 'arrival', arrived: 'services', installing: 'services', completed: 'completed' })[P.pickupStage(row)]);
  }
  function close() {
    if (C.isPartner()) return legacy.close();
    P.state.selectedId = ''; m.receipt = null; m.reason = ''; legacy.close(); navigate('queue');
  }
  function render() {
    if (!valid()) return;
    const previous = host.dataset.view, selectedId = P.state.selectedId || m.receipt?.order_id || '', same = previous === m.view && host.dataset.order === selectedId;
    const scroll = panel.scrollTop, focus = host.contains(document.activeElement) ? document.activeElement.id : '';
    let page, row = P.selected();
    if (m.view === 'completed') page = V.completed(m.receipt || row || {});
    else if (m.view === 'queue' || !row) { m.view = 'queue'; page = V.queue(m); }
    else if (m.phase !== 'ready') {
      page = V.el('div', null, 'mp-page'); page.append(V.heading('Retirada', 'queue'), V.el('p', m.phase === 'error' ? 'Não foi possível atualizar este atendimento.' : 'Atualizando atendimento…', 'mp-notice'));
      if (m.phase === 'error') page.appendChild(V.button('Tentar novamente', 'refresh', 'primary'));
    } else page = ({ arrival: V.arrival, services: V.services, payment: V.payment, cancel: V.cancellation })[m.view](row, m);
    const error = m.error || P.elements.sheetError.textContent;
    if (error) { const alert = V.el('p', error, 'mp-error'); alert.setAttribute('role', 'alert'); page.insertBefore(alert, page.children[1] || null); }
    if (m.busy || P.state.saving) { page.querySelectorAll('button,input,select,textarea').forEach(n => { n.disabled = true; }); page.setAttribute('aria-busy', 'true'); }
    host.replaceChildren(page); host.dataset.view = m.view; host.dataset.order = selectedId;
    if (m.view === 'queue') V.list(m, host.querySelector('#mp-list'));
    panel.scrollTop = same ? scroll : 0;
    if (focus) host.querySelector('#' + focus)?.focus({ preventScroll: true });
    else if (!same && previous) host.querySelector('h2')?.focus({ preventScroll: true });
  }
  function ensureServices(row) {
    if (!V.invalidServices(row)) return true;
    m.error = 'Informe um valor válido para cada serviço cobrado, até R$ 10.000,00.'; render(); return false;
  }
  async function mutate(kind) {
    const row = P.selected();
    if (!valid() || !row || m.busy || P.state.saving || m.phase !== 'ready') return;
    if (kind !== 'cancel-confirm' && !ensureServices(row)) return;
    if (kind === 'complete' && !m.received) return;
    if (kind === 'cancel-confirm' && !m.reason.trim()) { m.error = 'Informe o motivo do cancelamento.'; render(); return; }
    const own = m.session, epoch = m.epoch;
    const receipt = { ...row, total_amount: P.fullTotal(row), payment_method: P.state.payments[row.order_id] || 'Pix' };
    m.busy = true; m.error = ''; render();
    try {
      let result;
      if (kind === 'complete') result = await P.actions.completePickup();
      else if (kind === 'cancel-confirm') result = await P.actions.cancelPickup(m.reason.trim());
      else result = await P.actions.saveStage(({ arrived: 'arrived', install: 'installing', 'previous-stage': P.pickupStage(row) === 'installing' ? 'arrived' : 'waiting' })[kind]);
      if (!valid() || own !== m.session || epoch !== m.epoch) return;
      if (result) {
        if (kind === 'complete') { m.receipt = { ...receipt, ...result }; m.view = 'completed'; m.received = false; }
        else if (kind === 'cancel-confirm') m.view = 'queue';
        else m.view = P.pickupStage(P.selected()) === 'waiting' ? 'arrival' : 'services';
      }
    } finally { if (own === m.session && epoch === m.epoch) { m.busy = false; render(); } }
  }
  function servicesChanged() { m.received = false; m.error = ''; P.elements.sheetError.textContent = ''; render(); }
  host.addEventListener('click', event => {
    const b = event.target.closest('[data-mp-action]'); if (!b || b.disabled || !valid() || m.busy || P.state.saving) return;
    const action = b.dataset.mpAction, row = P.selected();
    if (action === 'open') return open(b.dataset.order);
    if (action === 'queue') return close();
    if (action === 'refresh') { m.received = false; return void C.loadPickups(); }
    if (action === 'filter') { P.state.filter = b.dataset.filter; return render(); }
    if (!row && !m.receipt) return;
    if (action === 'receipt') return void C.openReceipt((m.receipt || row).order_id);
    if (action === 'cancel') { m.cancelBack = m.view; m.reason = ''; return navigate('cancel'); }
    if (action === 'cancel-back') return navigate(m.cancelBack);
    if (action === 'services') return navigate('services');
    if (action === 'payment') { if (ensureServices(row)) { m.received = false; navigate('payment'); } return; }
    if (action === 'add-service') {
      const items = P.draftServices(row), next = P.state.serviceCatalog.find(item => !items.some(other => other.code === item.code));
      if (next) P.state.services[row.order_id] = [...items, { code: next.code, charge_mode: 'courtesy', amount_cents: 0 }]; return servicesChanged();
    }
    if (action === 'remove-service') { P.state.services[row.order_id] = P.draftServices(row).filter((_, i) => i !== Number(b.dataset.index)); return servicesChanged(); }
    if (action === 'service-mode') {
      const item = P.draftServices(row)[Number(b.dataset.index)]; if (!item) return;
      item.charge_mode = b.dataset.mode; if (item.charge_mode === 'courtesy') item.amount_cents = 0; return servicesChanged();
    }
    if (action !== 'cancel-confirm') void mutate(action);
  });
  host.addEventListener('input', event => {
    const input = event.target;
    if (input.id === 'mp-search') { P.state.search = input.value; V.list(m, host.querySelector('#mp-list')); return; }
    if (input.id === 'mp-cancel-reason') { m.reason = input.value; return; }
    if (input.dataset.field !== 'amount' || !valid() || P.state.saving || m.busy) return;
    const row = P.selected(), item = P.draftServices(row)[Number(input.dataset.serviceIndex)]; if (!item) return;
    const value = Number(input.value); item.amount_cents = input.value === '' || !Number.isFinite(value) ? NaN : Math.round(value * 100); m.received = false;
    const summary = host.querySelector('#mp-service-totals');
    if (summary) {
      summary.replaceChildren(...V.totals(row).children);
      if (V.invalidServices(row)) summary.querySelectorAll('strong').forEach(n => { n.textContent = '—'; });
    }
  });
  host.addEventListener('change', event => {
    const input = event.target, row = P.selected(); if (!valid() || !row || m.busy || P.state.saving) return;
    if (input.id === 'mp-received') { m.received = input.checked; host.querySelector('[data-mp-action="complete"]').disabled = !m.received || V.invalidServices(row); }
    else if (input.name === 'mp-payment') { P.state.payments[row.order_id] = input.value; m.received = false; render(); }
    else if (input.dataset.field === 'code') { const item = P.draftServices(row)[Number(input.dataset.serviceIndex)]; if (item) item.code = input.value; servicesChanged(); }
  });
  host.addEventListener('submit', event => { if (event.target.id === 'mp-cancel-form') { event.preventDefault(); void mutate('cancel-confirm'); } });
  P.renderList = function () { if (C.isPartner()) return legacy.list(); m.phase = 'ready'; render(); };
  P.renderSheet = function () { if (C.isPartner()) return legacy.sheet(); render(); };
  P.setStateView = function (kind) { legacy.state(kind); if (!C.isPartner()) { m.phase = kind === 'error' ? 'error' : kind === 'loading' ? 'loading' : 'ready'; render(); } };
  P.openSelected = open; P.closeSheet = close; C.openPickup = open; C.closePickup = close;
  C.matrixPickups = { reset, sync, state: m };
}());
