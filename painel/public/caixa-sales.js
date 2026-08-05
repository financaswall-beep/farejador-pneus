(function () {
  'use strict';

  const Caixa = window.Caixa;
  const elements = Caixa.elements;
  const state = Caixa.state;

  async function loadProfileSummary() {
    try {
      const response = await Caixa.authenticatedFetch('/api/caixa/vendas?period=today');
      const payload = await Caixa.json(response);
      if (!response.ok) throw new Error(payload.error || 'request_failed');
      Caixa.renderProfileSummary(payload.summary || {});
    } catch (failure) {
      if (failure instanceof Error && failure.message === 'invalid_session') return;
      elements.profileMetricSales.textContent = '—';
      elements.profileMetricRevenue.textContent = '—';
    }
  }

  async function loadSales() {
    if (!Caixa.token()) return;
    if (state.salesRequest) state.salesRequest.abort();
    const controller = new AbortController();
    state.salesRequest = controller;
    Caixa.setSalesState('loading');
    const params = new URLSearchParams({ period: '7d', week: String(state.weekOffset) });
    const search = elements.salesSearch.value.trim();
    if (search) params.set('search', search);
    try {
      const response = await Caixa.authenticatedFetch('/api/caixa/vendas?' + params.toString(), {
        signal: controller.signal,
      });
      const payload = await Caixa.json(response);
      if (!response.ok) throw new Error(payload.error || 'request_failed');
      Caixa.renderSales(payload);
    } catch (failure) {
      if (failure instanceof DOMException && failure.name === 'AbortError') return;
      if (failure instanceof Error && failure.message === 'invalid_session') return;
      Caixa.setSalesState('error');
    } finally {
      if (state.salesRequest === controller) state.salesRequest = null;
    }
  }

  async function openReceipt(orderId) {
    elements.receiptModal.classList.remove('hidden');
    elements.receiptContent.replaceChildren();
    const loading = document.createElement('p');
    loading.className = 'receipt-loading';
    loading.textContent = 'Carregando recibo…';
    elements.receiptContent.appendChild(loading);
    try {
      const response = await Caixa.authenticatedFetch(
        '/api/caixa/vendas/' + encodeURIComponent(orderId) + '/recibo',
      );
      const payload = await Caixa.json(response);
      if (!response.ok) throw new Error(payload.error || 'request_failed');
      Caixa.renderReceipt(payload);
    } catch (failure) {
      if (failure instanceof Error && failure.message === 'invalid_session') return;
      loading.textContent = 'Não foi possível abrir este recibo.';
    }
  }

  function closeReceipt() {
    elements.receiptModal.classList.add('hidden');
  }

  function showTab(tab) {
    const cash = tab === 'cash';
    const profile = tab === 'profile';
    const sales = tab === 'sales';
    elements.cashPanel.classList.toggle('hidden', !cash);
    elements.salesPanel.classList.toggle('hidden', !sales);
    elements.profilePanel.classList.toggle('hidden', !profile);
    elements.sessionView.classList.toggle('is-profile', profile);
    elements.sessionView.classList.toggle('is-cash', cash);
    elements.appHeadingTitle.textContent = profile ? 'Perfil' : cash ? 'Nova venda' : 'Vendas';
    document.getElementById('nav-cash').classList.toggle('active', cash);
    document.getElementById('nav-sales').classList.toggle('active', sales);
    document.getElementById('nav-profile').classList.toggle('active', profile);
    document.getElementById('nav-cash').toggleAttribute('aria-current', cash);
    document.getElementById('nav-sales').toggleAttribute('aria-current', sales);
    document.getElementById('nav-profile').toggleAttribute('aria-current', profile);
    if (profile) void loadProfileSummary();
  }

  Object.assign(Caixa, {
    loadProfileSummary: loadProfileSummary,
    loadSales: loadSales,
    openReceipt: openReceipt,
    closeReceipt: closeReceipt,
    showTab: showTab,
  });

  elements.weeklyPrev.addEventListener('click', function () {
    if (state.weekOffset <= -52) return;
    state.weekOffset -= 1;
    state.selectedSalesDay = null;
    void loadSales();
  });
  elements.weeklyNext.addEventListener('click', function () {
    if (state.weekOffset >= 0) return;
    state.weekOffset += 1;
    state.selectedSalesDay = null;
    void loadSales();
  });
  elements.weeklyClearDay.addEventListener('click', function () {
    Caixa.selectWeeklyDay(null);
  });

  elements.salesSearch.addEventListener('input', function () {
    elements.searchClear.classList.toggle('hidden', !elements.salesSearch.value);
    window.clearTimeout(state.searchTimer);
    state.searchTimer = window.setTimeout(function () { void loadSales(); }, 320);
  });
  elements.searchClear.addEventListener('click', function () {
    elements.salesSearch.value = '';
    elements.searchClear.classList.add('hidden');
    elements.salesSearch.focus();
    void loadSales();
  });
  document.getElementById('sales-retry').addEventListener('click', function () { void loadSales(); });
  document.getElementById('operator-button').addEventListener('click', function () { showTab('profile'); });
  document.getElementById('nav-profile').addEventListener('click', function () { showTab('profile'); });
  document.getElementById('nav-sales').addEventListener('click', function () {
    showTab('sales');
    void loadSales();
  });
  document.getElementById('nav-cash').addEventListener('click', function () {
    showTab('cash');
    void Caixa.loadCatalog();
  });
  document.querySelectorAll('[data-close-receipt]').forEach(function (button) {
    button.addEventListener('click', closeReceipt);
  });
  document.getElementById('receipt-print').addEventListener('click', function () { window.print(); });
}());
