(function () {
  'use strict';
  const C = window.Caixa;
  function load(tab) {
    if (tab === 'partner-stock') return C.partnerStock.load();
    if (tab === 'partner-profile') return C.partnerStore.load();
  }
  function render(tab) {
    if (tab === 'partner-stock') { C.partnerStock.render(); return; }
    C.partnerStore.render();
  }
  function reset() { C.partnerStock.reset(); C.partnerStore.leave(); }
  C.partnerExtras = { load, render, reset };
}());
