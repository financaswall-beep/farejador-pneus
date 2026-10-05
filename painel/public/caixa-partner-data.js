(function () {
  'use strict';
  const C = window.Caixa;
  const state = { pickups: [], deliveries: [], waiting: [], replenishment: null, offers: [], errors: [], ready: false };
  let generation = 0;
  let controller = null;
  let poll = 0;
  async function api(resource, options) {
    if (!C.isPartner() || !C.token()) throw new Error('invalid_session');
    const response = await C.authenticatedFetch(C.operationPath(resource), options);
    const payload = await C.json(response);
    if (!response.ok) {
      const error = new Error(payload.error || 'request_failed');
      error.status = response.status; throw error;
    }
    return payload;
  }
  async function load() {
    if (!C.isPartner() || !C.token()) return;
    const current = ++generation;
    const session = C.sessionFingerprint();
    controller?.abort(); controller = new AbortController();
    const resources = [
      ['pickups', 'retiradas', 'retiradas'],
      ['deliveries', 'operacao/entregas', 'entregas'],
      ['waiting', 'operacao/confirmacoes-estoque', 'vendas'],
      ['replenishment', 'operacao/reposicao', 'estoque'],
    ].filter(([, , permission]) => C.canModule(permission));
    const results = await Promise.allSettled(resources.map(([, resource]) => api(resource, { signal: controller.signal })));
    if (current !== generation || session !== C.sessionFingerprint()) return;
    state.errors = [];
    resources.forEach(([key], i) => {
      const result = results[i];
      if (result.status === 'fulfilled') {
        if (key === 'replenishment') {
          state.replenishment = result.value.replenishment || null;
          state.offers = Array.isArray(result.value.rows) ? result.value.rows : [];
        } else state[key] = Array.isArray(result.value.rows) ? result.value.rows : [];
      }
      else {
        state.errors.push(key);
        if (key === 'replenishment') { state.replenishment = null; state.offers = []; }
      }
    });
    state.ready = true; controller = null;
    C.partnerWaiting.sync(state.waiting);
    C.partnerHome?.render();
  }
  function start() {
    window.clearInterval(poll);
    void load(); poll = window.setInterval(load, 10000);
  }
  function reset() {
    ++generation; controller?.abort(); controller = null;
    window.clearInterval(poll); poll = 0;
    Object.assign(state, { pickups: [], deliveries: [], waiting: [], replenishment: null, offers: [], errors: [], ready: false });
  }
  function pendingPickups() {
    return state.pickups.filter(row => row.awaiting_pickup && !row.retrieved_at && row.status !== 'cancelled');
  }
  function pendingDeliveries() {
    return state.deliveries.filter(row => ['pending', 'dispatched', 'failed'].includes(row.delivery_status) && row.order_status !== 'cancelled');
  }
  C.partnerData = { state, api, load, start, reset, pendingPickups, pendingDeliveries };
}());
