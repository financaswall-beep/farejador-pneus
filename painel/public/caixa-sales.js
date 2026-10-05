(function () {
  'use strict';
  const Caixa = window.Caixa;
  const elements = Caixa.elements;
  const state = Caixa.state;
  function salesPath() {
    return Caixa.operationPath('minhas-vendas', '/api/caixa/vendas');
  }
  function detailPath(orderId) {
    if (Caixa.isPartner()) {
      return Caixa.operationPath('minhas-vendas/' + encodeURIComponent(orderId));
    }
    return '/api/caixa/vendas/' + encodeURIComponent(orderId) + '/recibo';
  }
  async function loadProfileSummary() {
    if (!Caixa.canModule('vendas')) return;
    const session = Caixa.sessionFingerprint();
    try {
      const response = await Caixa.authenticatedFetch(salesPath() + '?week=0&scope=own');
      const payload = await Caixa.json(response);
      if (session !== Caixa.sessionFingerprint()) return;
      if (!response.ok) throw new Error(payload.error || 'request_failed');
      Caixa.renderProfileSummary(payload.summary || {});
    } catch (failure) {
      if (session !== Caixa.sessionFingerprint()) return;
      if (failure instanceof Error && failure.message === 'invalid_session') return;
      elements.profileMetricSales.textContent = '—';
      elements.profileMetricRevenue.textContent = '—';
    }
  }
  async function loadSales() {
    if (!Caixa.token()) return;
    const session = Caixa.sessionFingerprint();
    if (state.salesRequest) state.salesRequest.abort();
    const controller = new AbortController();
    state.salesRequest = controller;
    Caixa.setSalesState('loading');
    const params = new URLSearchParams({ week: String(state.weekOffset) });
    try {
      const response = await Caixa.authenticatedFetch(salesPath() + '?' + params.toString(), {
        signal: controller.signal,
      });
      const payload = await Caixa.json(response);
      if (session !== Caixa.sessionFingerprint() || state.salesRequest !== controller) return;
      if (!response.ok) throw new Error(payload.error || 'request_failed');
      Caixa.renderSales(payload);
    } catch (failure) {
      if (session !== Caixa.sessionFingerprint() || state.salesRequest !== controller) return;
      if (failure instanceof DOMException && failure.name === 'AbortError') return;
      if (failure instanceof Error && failure.message === 'invalid_session') return;
      Caixa.setSalesState('error');
    } finally {
      if (state.salesRequest === controller) state.salesRequest = null;
    }
  }

  async function openReceipt(orderId) {
    const session = Caixa.sessionFingerprint();
    if (Caixa.isPartner()) Caixa.partnerReceipt?.open();
    elements.receiptModal.classList.remove('hidden');
    elements.receiptContent.replaceChildren();
    const loading = document.createElement('p');
    loading.className = 'receipt-loading';
    loading.textContent = 'Carregando detalhes…';
    elements.receiptContent.appendChild(loading);
    try {
      const response = await Caixa.authenticatedFetch(detailPath(orderId));
      const payload = await Caixa.json(response);
      if (session !== Caixa.sessionFingerprint() || !loading.isConnected) return;
      if (!response.ok) throw new Error(payload.error || 'request_failed');
      Caixa.renderReceipt(payload);
    } catch (failure) {
      if (session !== Caixa.sessionFingerprint() || !loading.isConnected) return;
      if (failure instanceof Error && failure.message === 'invalid_session') return;
      loading.textContent = 'Não foi possível abrir esta venda.';
    }
  }

  function closeReceipt() {
    elements.receiptModal.classList.add('hidden');
    elements.receiptContent.replaceChildren();
    Caixa.partnerReceipt?.close();
  }
  function resetSales() {
    if (state.salesRequest) state.salesRequest.abort();
    state.salesRequest = null;
    state.salesPayload = null;
    state.selectedSalesDay = null;
    state.weekOffset = 0;
    elements.weeklySummary.classList.add('hidden');
    elements.salesList.replaceChildren();
    elements.profileMetricSales.textContent = '—';
    elements.profileMetricRevenue.textContent = '—';
    closeReceipt();
  }
  Object.assign(Caixa, {
    resetSales: resetSales,
    loadProfileSummary: loadProfileSummary,
    loadSales: loadSales,
    openReceipt: openReceipt,
    closeReceipt: closeReceipt,
  });

  elements.weeklyPrev.addEventListener('click', function () {
    if (state.weekOffset <= -52) return;
    state.selectedSalesDay = null;
    state.weekOffset -= 1;
    void loadSales();
  });
  elements.weeklyNext.addEventListener('click', function () {
    if (state.weekOffset >= 0) return;
    state.selectedSalesDay = null;
    state.weekOffset += 1;
    void loadSales();
  });
  elements.weeklyBars.addEventListener('click', function (event) {
    const button = event.target.closest('[data-sales-day]');
    if (button) Caixa.selectSalesDay(button.dataset.salesDay || '');
  });
  elements.weeklyClearDay.addEventListener('click', Caixa.clearSalesDay);
  document.getElementById('sales-retry').addEventListener('click', function () { void loadSales(); });
  document.getElementById('operator-button').addEventListener('click', function () { Caixa.showTab('profile'); });
  document.getElementById('nav-profile').addEventListener('click', function () { Caixa.showTab('profile'); });
  document.getElementById('nav-conversations').addEventListener('click', function () {
    history.replaceState(null, '', location.pathname + location.search + '#conversas');
    Caixa.showTab('conversations');
  });
  document.getElementById('nav-sales').addEventListener('click', function () {
    if (!Caixa.canModule('vendas')) return;
    Caixa.showTab('sales');
    void loadSales();
  });
  document.getElementById('nav-pickups').addEventListener('click', function () {
    if (!Caixa.canModule('retiradas')) {
      Caixa.showToast('Retiradas não está disponível para este acesso.');
      return;
    }
    window.location.hash = '#retiradas';
    Caixa.showTab('pickups');
  });
  document.getElementById('nav-catalog').addEventListener('click', function () {
    if (!Caixa.canModule('estoque')) {
      Caixa.showToast('Catálogo não está disponível para este acesso.');
      return;
    }
    window.location.hash = '#catalogo';
    Caixa.showTab('catalog');
    if (Caixa.loadOperationCatalog) void Caixa.loadOperationCatalog();
  });
  document.getElementById('nav-stock').addEventListener('click', function () {
    if (!Caixa.canModule('estoque')) {
      Caixa.showToast('Estoque não está disponível para este acesso.');
      return;
    }
    Caixa.showTab('stock');
    void Caixa.loadStock();
  });
  document.getElementById('nav-deliveries').addEventListener('click', function () {
    if (!Caixa.canModule('entregas')) {
      Caixa.showToast('Entregas não está disponível para este acesso.');
      return;
    }
    Caixa.showTab('deliveries');
    void Caixa.loadDeliveries();
  });
  document.getElementById('nav-finance').addEventListener('click', function () {
    if (!Caixa.canModule('financeiro')) {
      Caixa.showToast('Financeiro disponível somente para proprietário ou administrador.');
      return;
    }
    Caixa.showTab('finance');
    window.location.hash = '#financeiro';
    void Caixa.loadFinance();
  });
  document.getElementById('nav-team').addEventListener('click', function () {
    if (!Caixa.canModule('team')) {
      Caixa.showToast('Equipe disponível somente para o proprietário.');
      return;
    }
    window.location.hash = '#equipe';
    Caixa.showTab('team');
  });
  document.getElementById('nav-cash').addEventListener('click', function () {
    Caixa.showTab('cash');
    void Caixa.loadCatalog();
  });
  document.querySelectorAll('[data-close-receipt]').forEach(function (button) {
    button.addEventListener('click', closeReceipt);
  });
  document.getElementById('receipt-print').addEventListener('click', function () { window.print(); });
}());
