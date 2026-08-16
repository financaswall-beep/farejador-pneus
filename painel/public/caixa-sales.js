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
    try {
      const response = await Caixa.authenticatedFetch(salesPath() + '?week=0');
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
    const params = new URLSearchParams({ week: String(state.weekOffset) });
    try {
      const response = await Caixa.authenticatedFetch(salesPath() + '?' + params.toString(), {
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
    loading.textContent = 'Carregando detalhes…';
    elements.receiptContent.appendChild(loading);
    try {
      const response = await Caixa.authenticatedFetch(detailPath(orderId));
      const payload = await Caixa.json(response);
      if (!response.ok) throw new Error(payload.error || 'request_failed');
      Caixa.renderReceipt(payload);
    } catch (failure) {
      if (failure instanceof Error && failure.message === 'invalid_session') return;
      loading.textContent = 'Não foi possível abrir esta venda.';
    }
  }

  function closeReceipt() {
    elements.receiptModal.classList.add('hidden');
  }

  function showTab(tab) {
    const cash = tab === 'cash';
    const profile = tab === 'profile';
    const sales = tab === 'sales';
    const stock = tab === 'stock';
    const stockDetail = tab === 'stock-detail';
    const stockReceipts = tab === 'stock-receipts';
    const deliveries = tab === 'deliveries';
    const finance = tab === 'finance';
    const financeEntries = tab === 'finance-in' || tab === 'finance-out';
    const financeCommissions = tab === 'finance-commissions';
    const financeCommissionDetail = tab === 'finance-commission-detail';
    const team = tab === 'team';
    const teamRemuneration = tab === 'team-remuneration';
    const teamCommission = tab === 'team-commission';
    const teamPermissions = tab === 'team-permissions';
    const notifications = tab === 'notifications';
    if (financeEntries && Caixa.setFinanceMovementMode) {
      Caixa.setFinanceMovementMode(tab === 'finance-out' ? 'out' : 'in');
    }
    if (!sales) {
      if (state.weekOffset !== 0) state.weekOffset = 0;
      state.selectedSalesDay = null;
    }
    elements.cashPanel.classList.toggle('hidden', !cash);
    elements.salesPanel.classList.toggle('hidden', !sales);
    elements.deliveriesPanel.classList.toggle('hidden', !deliveries);
    elements.financePanel.classList.toggle('hidden', !finance);
    document.getElementById('finance-entries-panel').classList.toggle('hidden', !financeEntries);
    document.getElementById('finance-commissions-panel').classList.toggle('hidden', !financeCommissions);
    document.getElementById('finance-commission-detail-panel').classList.toggle('hidden', !financeCommissionDetail);
    document.getElementById('team-panel').classList.toggle('hidden', !team);
    document.getElementById('team-remuneration-panel').classList.toggle('hidden', !teamRemuneration);
    document.getElementById('team-commission-panel').classList.toggle('hidden', !teamCommission);
    document.getElementById('team-permissions-panel').classList.toggle('hidden', !teamPermissions);
    elements.notificationsPanel.classList.toggle('hidden', !notifications);
    elements.profilePanel.classList.toggle('hidden', !profile);
    document.getElementById('stock-panel').classList.toggle('hidden', !stock);
    document.getElementById('stock-detail-panel').classList.toggle('hidden', !stockDetail);
    document.getElementById('stock-receipts-panel').classList.toggle('hidden', !stockReceipts);
    elements.sessionView.classList.toggle('is-profile', profile);
    elements.sessionView.classList.toggle('is-cash', cash);
    elements.sessionView.classList.toggle('is-sales', sales);
    elements.sessionView.classList.toggle('is-stock', stock || stockDetail || stockReceipts);
    elements.sessionView.classList.toggle('is-stock-detail', stockDetail || stockReceipts);
    elements.sessionView.classList.toggle('is-deliveries', deliveries);
    elements.sessionView.classList.toggle('is-finance', finance || financeEntries || financeCommissions || financeCommissionDetail);
    elements.sessionView.classList.toggle('is-finance-detail', financeEntries || financeCommissions || financeCommissionDetail);
    elements.sessionView.classList.toggle('is-team', team || teamRemuneration || teamCommission || teamPermissions);
    elements.sessionView.classList.toggle('is-team-detail', teamRemuneration || teamCommission || teamPermissions);
    elements.sessionView.classList.toggle('is-notifications', notifications);
    elements.appHeadingTitle.textContent = profile ? 'Perfil'
      : stockReceipts ? 'Receber compra'
        : stockDetail ? 'Detalhes do produto'
          : stock ? 'Estoque' : deliveries ? 'Entregas'
            : (team || teamRemuneration || teamCommission || teamPermissions) ? 'Equipe'
              : (finance || financeEntries || financeCommissions || financeCommissionDetail) ? 'Financeiro'
                : notifications ? 'Notificações' : cash ? 'Vender' : 'Minhas vendas';
    document.getElementById('nav-cash').classList.toggle('active', cash);
    document.getElementById('nav-sales').classList.toggle('active', sales);
    document.getElementById('nav-stock').classList.toggle('active', stock || stockDetail || stockReceipts);
    document.getElementById('nav-deliveries').classList.toggle('active', deliveries);
    document.getElementById('nav-finance').classList.toggle('active', finance || financeEntries || financeCommissions || financeCommissionDetail);
    document.getElementById('nav-team').classList.toggle('active', team || teamRemuneration || teamCommission || teamPermissions);
    document.getElementById('nav-profile').classList.toggle('active', profile);
    document.getElementById('nav-cash').toggleAttribute('aria-current', cash);
    document.getElementById('nav-sales').toggleAttribute('aria-current', sales);
    document.getElementById('nav-stock').toggleAttribute('aria-current', stock || stockDetail || stockReceipts);
    document.getElementById('nav-deliveries').toggleAttribute('aria-current', deliveries);
    document.getElementById('nav-finance').toggleAttribute('aria-current', finance || financeEntries || financeCommissions || financeCommissionDetail);
    document.getElementById('nav-team').toggleAttribute('aria-current', team || teamRemuneration || teamCommission || teamPermissions);
    document.getElementById('nav-profile').toggleAttribute('aria-current', profile);
    document.getElementById('notifications-button').classList.toggle('active', notifications);
    if (!(financeEntries || financeCommissions || financeCommissionDetail)
      && (['#financeiro/entradas', '#financeiro/saidas', '#financeiro/comissoes'].includes(window.location.hash)
        || window.location.hash.startsWith('#financeiro/comissoes/'))) {
      const nextHash = finance ? '#financeiro' : sales ? '#vendas' : deliveries ? '#entregas' : '';
      window.history.replaceState(null, '', window.location.pathname + window.location.search + nextHash);
    }
    if (!(team || teamRemuneration || teamCommission || teamPermissions) && window.location.hash.startsWith('#equipe')) {
      const nextHash = finance ? '#financeiro' : sales ? '#vendas' : deliveries ? '#entregas' : '';
      window.history.replaceState(null, '', window.location.pathname + window.location.search + nextHash);
    }
    if (!notifications && window.location.hash === '#notificacoes') {
      const nextHash = finance ? '#financeiro' : sales ? '#vendas' : deliveries ? '#entregas' : '';
      window.history.replaceState(null, '', window.location.pathname + window.location.search + nextHash);
    }
    if (profile) void loadProfileSummary();
    if (financeEntries && Caixa.loadFinanceEntries) void Caixa.loadFinanceEntries();
    if (financeCommissions && Caixa.loadFinanceCommissions) void Caixa.loadFinanceCommissions();
    if (financeCommissionDetail && Caixa.loadFinanceCommissionDetail) void Caixa.loadFinanceCommissionDetail();
    if (team && Caixa.loadTeam) void Caixa.loadTeam();
    if (teamRemuneration && Caixa.loadTeamRemuneration) void Caixa.loadTeamRemuneration();
    if (teamCommission && Caixa.loadTeamCommission) void Caixa.loadTeamCommission();
    if (teamPermissions && Caixa.loadTeamPermissions) void Caixa.loadTeamPermissions();
    if (notifications && Caixa.loadSystemNotifications) void Caixa.loadSystemNotifications();

    const activeNavigation = document.querySelector('.bottom-nav button.active');
    if (activeNavigation) requestAnimationFrame(function () {
      activeNavigation.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    });
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
  document.getElementById('operator-button').addEventListener('click', function () { showTab('profile'); });
  document.getElementById('nav-profile').addEventListener('click', function () { showTab('profile'); });
  document.getElementById('nav-sales').addEventListener('click', function () {
    if (!Caixa.canModule('vendas')) return;
    showTab('sales');
    void loadSales();
  });
  document.getElementById('nav-stock').addEventListener('click', function () {
    if (!Caixa.canModule('estoque')) {
      Caixa.showToast('Estoque não está disponível para este acesso.');
      return;
    }
    showTab('stock');
    void Caixa.loadStock();
  });
  document.getElementById('nav-deliveries').addEventListener('click', function () {
    if (!Caixa.canModule('entregas')) {
      Caixa.showToast('Entregas não está disponível para este acesso.');
      return;
    }
    showTab('deliveries');
    void Caixa.loadDeliveries();
  });
  document.getElementById('nav-finance').addEventListener('click', function () {
    if (!Caixa.canModule('financeiro')) {
      Caixa.showToast('Financeiro disponível somente para proprietário ou administrador.');
      return;
    }
    showTab('finance');
    window.location.hash = '#financeiro';
    void Caixa.loadFinance();
  });
  document.getElementById('nav-team').addEventListener('click', function () {
    if (!Caixa.canModule('team')) {
      Caixa.showToast('Equipe disponível somente para o proprietário.');
      return;
    }
    window.location.hash = '#equipe';
    showTab('team');
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
