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
    if (name === 'profile') return true;
    return modules()[name] === true;
  }

  function setNavigationVisibility(id, visible) {
    const button = document.getElementById(id);
    if (button) button.classList.toggle('hidden', !visible);
  }

  function applyModuleNavigation() {
    setNavigationVisibility('nav-cash', canModule('vendas'));
    setNavigationVisibility('nav-sales', canModule('vendas'));
    setNavigationVisibility('nav-stock', Caixa.isPartner() && canModule('estoque'));
    setNavigationVisibility('nav-deliveries', canModule('entregas'));
    const nav = document.querySelector('.bottom-nav');
    if (nav) {
      const visible = nav.querySelectorAll('button:not(.hidden)').length;
      nav.style.gridTemplateColumns = `repeat(${Math.max(visible, 1)},1fr)`;
    }
  }

  function initialOperationTab() {
    if (!Caixa.isPartner() && window.location.hash === '#vendas') return 'sales';
    if (canModule('vendas')) return 'cash';
    if (Caixa.isPartner() && canModule('estoque')) return 'stock';
    return 'profile';
  }

  Object.assign(Caixa, {
    operationModules: modules,
    canModule: canModule,
    applyModuleNavigation: applyModuleNavigation,
    initialOperationTab: initialOperationTab,
  });
}());
