(function () {
  'use strict';
  const Caixa = window.Caixa;
  const elements = Caixa.elements;
  const state = Caixa.state;
  function showTab(tab) {
    tab = Caixa.authorizedOperationTab ? Caixa.authorizedOperationTab(tab) : tab;
    if (Caixa.isPartner() && Caixa.partnerHome) {
      Caixa.checkoutRuntime?.close();
      Caixa.partnerHome.sync(tab);
      return;
    }
    const cash = tab === 'cash';
    if (!cash) Caixa.checkoutRuntime?.close();
    const profile = tab === 'profile';
    const sales = tab === 'sales';
    const pickups = tab === 'pickups';
    const catalog = tab === 'catalog';
    const stock = tab === 'stock';
    const stockDetail = tab === 'stock-detail';
    const stockReceipts = tab === 'stock-receipts';
    const deliveries = tab === 'deliveries';
    const finance = tab === 'finance';
    const financeEntries = ['finance-in', 'finance-out', 'finance-statement', 'finance-accounts', 'finance-expense', 'finance-reports'].includes(tab);
    const matrixFinance = !Caixa.isPartner() && (finance || financeEntries || tab === 'finance-commissions');
    if (!matrixFinance && Caixa.financeMatrix) Caixa.financeMatrix.cancel();
    const financeCommissions = tab === 'finance-commissions';
    const financeCommissionDetail = tab === 'finance-commission-detail';
    const team = tab === 'team';
    const teamRemuneration = tab === 'team-remuneration';
    const teamCommission = tab === 'team-commission';
    const teamPermissions = tab === 'team-permissions';
    const notifications = tab === 'notifications';
    if (financeEntries && !matrixFinance && Caixa.setFinanceMovementMode) {
      Caixa.setFinanceMovementMode(tab === 'finance-out' ? 'out' : 'in');
    }
    if (!sales) {
      if (state.weekOffset !== 0) state.weekOffset = 0;
      state.selectedSalesDay = null;
    }
    elements.cashPanel.classList.toggle('hidden', !cash);
    elements.salesPanel.classList.toggle('hidden', !sales);
    elements.pickupsPanel.classList.toggle('hidden', !pickups);
    elements.catalogPanel.classList.toggle('hidden', !catalog);
    elements.deliveriesPanel.classList.toggle('hidden', !deliveries);
    elements.financePanel.classList.toggle('hidden', !finance || matrixFinance);
    document.getElementById('finance-entries-panel').classList.toggle('hidden', !financeEntries || matrixFinance);
    document.getElementById('matrix-finance-panel').classList.toggle('hidden', !matrixFinance);
    elements.sessionView.classList.toggle('is-matrix-finance', matrixFinance);
    document.getElementById('finance-commissions-panel').classList.toggle('hidden', !financeCommissions || matrixFinance);
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
    elements.sessionView.classList.toggle('is-pickups', pickups);
    elements.sessionView.classList.toggle('is-catalog', catalog);
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
          : stock ? 'Estoque' : catalog ? 'Catálogo' : pickups ? 'Retiradas' : deliveries ? 'Entregas'
            : (team || teamRemuneration || teamCommission || teamPermissions) ? 'Equipe'
              : (finance || financeEntries || financeCommissions || financeCommissionDetail) ? 'Financeiro'
                : notifications ? 'Notificações' : cash ? 'Caixa' : Caixa.matrixSales() ? 'Vendas da Matriz' : 'Minhas vendas';
    document.getElementById('nav-cash').classList.toggle('active', cash);
    document.getElementById('nav-sales').classList.toggle('active', sales);
    document.getElementById('nav-pickups').classList.toggle('active', pickups);
    document.getElementById('nav-catalog').classList.toggle('active', catalog);
    document.getElementById('nav-stock').classList.toggle('active', stock || stockDetail || stockReceipts);
    document.getElementById('nav-deliveries').classList.toggle('active', deliveries);
    document.getElementById('nav-finance').classList.toggle('active', finance || financeEntries || financeCommissions || financeCommissionDetail);
    document.getElementById('nav-team').classList.toggle('active', team || teamRemuneration || teamCommission || teamPermissions);
    document.getElementById('nav-profile').classList.toggle('active', profile);
    document.getElementById('nav-cash').toggleAttribute('aria-current', cash);
    document.getElementById('nav-sales').toggleAttribute('aria-current', sales);
    document.getElementById('nav-pickups').toggleAttribute('aria-current', pickups);
    document.getElementById('nav-catalog').toggleAttribute('aria-current', catalog);
    document.getElementById('nav-stock').toggleAttribute('aria-current', stock || stockDetail || stockReceipts);
    document.getElementById('nav-deliveries').toggleAttribute('aria-current', deliveries);
    document.getElementById('nav-finance').toggleAttribute('aria-current', finance || financeEntries || financeCommissions || financeCommissionDetail);
    document.getElementById('nav-team').toggleAttribute('aria-current', team || teamRemuneration || teamCommission || teamPermissions);
    document.getElementById('nav-profile').toggleAttribute('aria-current', profile);
    document.getElementById('notifications-button').classList.toggle('active', notifications);
    if (!(financeEntries || financeCommissions || financeCommissionDetail)
      && (['#financeiro/entradas', '#financeiro/saidas', '#financeiro/extrato', '#financeiro/contas', '#financeiro/comissoes', '#financeiro/despesa', '#financeiro/relatorios'].includes(window.location.hash)
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
    if (!pickups && window.location.hash === '#retiradas') {
      const nextHash = finance ? '#financeiro' : sales ? '#vendas' : deliveries ? '#entregas' : '';
      window.history.replaceState(null, '', window.location.pathname + window.location.search + nextHash);
    }
    if (!catalog && window.location.hash === '#catalogo') {
      const nextHash = finance ? '#financeiro' : sales ? '#vendas' : deliveries ? '#entregas' : '';
      window.history.replaceState(null, '', window.location.pathname + window.location.search + nextHash);
    }
    if (profile) void Caixa.loadProfileSummary();
    if (matrixFinance && Caixa.financeMatrix) Caixa.financeMatrix.setTab(tab);
    if (financeEntries && matrixFinance && Caixa.financeMatrix) void Caixa.financeMatrix.load();
    else if (financeEntries && Caixa.loadFinanceEntries) void Caixa.loadFinanceEntries();
    if (financeCommissions && matrixFinance && Caixa.financeMatrix) void Caixa.financeMatrix.load();
    else if (financeCommissions && Caixa.loadFinanceCommissions) void Caixa.loadFinanceCommissions();
    if (financeCommissionDetail && Caixa.loadFinanceCommissionDetail) void Caixa.loadFinanceCommissionDetail();
    if (team && Caixa.loadTeam) void Caixa.loadTeam();
    if (teamRemuneration && Caixa.loadTeamRemuneration) void Caixa.loadTeamRemuneration();
    if (teamCommission && Caixa.loadTeamCommission) void Caixa.loadTeamCommission();
    if (teamPermissions && Caixa.loadTeamPermissions) void Caixa.loadTeamPermissions();
    if (notifications && Caixa.loadSystemNotifications) void Caixa.loadSystemNotifications();
    if (pickups && Caixa.loadPickups) void Caixa.loadPickups();

    if (Caixa.purchases) Caixa.purchases.syncTab(tab);
    if (Caixa.chat) Caixa.chat.syncTab(tab);
    if (Caixa.waitlist) Caixa.waitlist.syncTab(tab);
    if (Caixa.partnerHome) Caixa.partnerHome.sync(tab);
    const partnerNavigation = document.getElementById('nav-partner-home');
    partnerNavigation.classList.toggle('active', tab === 'partner-home');
    if (tab === 'partner-home') partnerNavigation.setAttribute('aria-current', 'page');
    else partnerNavigation.removeAttribute('aria-current');
    const activeNavigation = document.querySelector('.bottom-nav button.active');
    if (activeNavigation) requestAnimationFrame(function () {
      activeNavigation.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    });
  }

  Caixa.showTab = showTab;
}());
