(function () {
  'use strict';
  const C = window.Caixa;
  const U = C.partnerUI;
  function load(tab) { if (tab === 'partner-stock') return C.partnerStock.load(); }
  function profile(page) {
    page.appendChild(U.info('Operador', C.stored(C.keys.name) || 'Operador'));
    page.appendChild(U.info('Loja', C.stored(C.keys.store) || 'Minha loja'));
    const enabled = localStorage.getItem(C.keys.notifications) !== 'false';
    const sound = U.button(enabled ? 'SOM ATIVADO' : 'ATIVAR SOM', () => {
      C.elements.notificationsToggle.click(); render('partner-profile');
    }, 'secondary'); sound.setAttribute('aria-pressed', String(enabled)); page.appendChild(sound);
    page.appendChild(U.button('SAIR', () => C.elements.logout.click(), 'secondary'));
  }
  function render(tab) {
    if (tab === 'partner-stock') { C.partnerStock.render(); return; }
    const page = U.section('Minha loja', () => C.partnerHome.open('partner-home'));
    profile(page); U.mount(page, 'profile');
  }
  function reset() { C.partnerStock.reset(); }
  C.partnerExtras = { load, render, reset };
}());
