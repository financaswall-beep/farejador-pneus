(function () {
  'use strict';

  const Caixa = window.Caixa;

  function modules() {
    try {
      return JSON.parse(Caixa.stored(Caixa.keys.modules) || '{}');
    } catch {
      return {};
    }
  }

  function canModule(name) {
    if (name === 'team') return Caixa.stored(Caixa.keys.role) === 'owner';
    if (name === 'profile') return true;
    return modules()[name] === true;
  }

  function syncSessionMetadata(data) {
    if (!data || typeof data !== 'object') return;
    const keys = Caixa.keys;
    const storage = sessionStorage.getItem(keys.token) ? sessionStorage : localStorage;
    const effective = data.modules || (data.permissions ? {
      vendas: !!data.permissions.vendas, estoque: !!data.permissions.estoque,
      entregas: !!data.permissions.entregas, financeiro: !!data.permissions.financeiro,
    } : null);
    if (data.display_name) storage.setItem(keys.name, data.display_name);
    if (data.username) storage.setItem(keys.user, data.username);
    if (data.role) storage.setItem(keys.role, data.role);
    if (data.unit_name || data.store_name) storage.setItem(keys.store, data.unit_name || data.store_name);
    if (data.slug) storage.setItem(keys.slug, data.slug);
    if (effective) storage.setItem(keys.modules, JSON.stringify(effective));
  }

  function setNavigationVisibility(id, visible) {
    const button = document.getElementById(id);
    if (button) button.classList.toggle('hidden', !visible);
  }

  function applyModuleNavigation() {
    setNavigationVisibility('nav-cash', canModule('vendas'));
    setNavigationVisibility('nav-sales', canModule('vendas'));
    setNavigationVisibility('nav-stock', canModule('estoque'));
    setNavigationVisibility('nav-deliveries', canModule('entregas'));
    setNavigationVisibility('nav-finance', canModule('financeiro'));
    setNavigationVisibility('nav-team', canModule('team'));
    setNavigationVisibility('nav-profile', !canModule('financeiro'));
    const nav = document.querySelector('.bottom-nav');
    if (nav) nav.style.removeProperty('grid-template-columns');
  }

  function initialOperationTab() {
    if (window.location.hash === '#notificacoes') return 'notifications';
    if (canModule('financeiro') && window.location.hash === '#financeiro/entradas') return 'finance-in';
    if (canModule('financeiro') && window.location.hash === '#financeiro/saidas') return 'finance-out';
    if (canModule('financeiro') && window.location.hash === '#financeiro/comissoes') return 'finance-commissions';
    if (canModule('financeiro') && window.location.hash.startsWith('#financeiro/comissoes/')) return 'finance-commission-detail';
    if (canModule('team') && window.location.hash === '#equipe') return 'team';
    if (canModule('team') && window.location.hash.startsWith('#equipe/remuneracao/')) return 'team-remuneration';
    if (canModule('team') && window.location.hash.startsWith('#equipe/comissao/')) return 'team-commission';
    if (canModule('team') && window.location.hash.startsWith('#equipe/permissoes/')) return 'team-permissions';
    if (canModule('vendas') && window.location.hash === '#vendas') return 'sales';
    if (canModule('entregas') && window.location.hash === '#entregas') return 'deliveries';
    if (canModule('financeiro') && window.location.hash === '#financeiro') return 'finance';
    if (canModule('vendas')) return 'cash';
    if (canModule('estoque')) return 'stock';
    if (canModule('entregas')) return 'deliveries';
    if (canModule('financeiro')) return 'finance';
    return 'profile';
  }

  Object.assign(Caixa, {
    operationModules: modules,
    syncSessionMetadata: syncSessionMetadata,
    canModule: canModule,
    applyModuleNavigation: applyModuleNavigation,
    initialOperationTab: initialOperationTab,
  });
}());
