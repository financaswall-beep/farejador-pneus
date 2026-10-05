(function () {
  'use strict';
  const C = window.Caixa;
  const U = C.partnerUI;
  const panel = C.elements.salesPanel;
  const parent = panel.parentNode;
  const next = panel.nextSibling;
  const weekNav = C.elements.weeklyPrev.parentNode;
  const weekParent = weekNav.parentNode;
  const weekNext = weekNav.nextSibling;
  let page = null;

  // Move a tela existente, com seus controles e listeners, para o casco do parceiro.
  // Ao sair, devolve o mesmo elemento à posição original usada pela Matriz.
  function render() {
    if (!C.isPartner() || !C.canModule('vendas')) return;
    if (!page) {
      page = U.section('Vendas');
      page.classList.add('ps-sales');
      page.children[0].appendChild(weekNav);
      page.appendChild(panel);
      U.mount(page, 'sales');
      U.root.scrollTop = 0;
    }
    panel.classList.remove('hidden');
  }
  function load() {
    if (!C.isPartner() || !C.canModule('vendas')) return;
    return C.loadSales();
  }
  function leave() {
    if (!page) return;
    weekParent.insertBefore(weekNav, weekNext);
    parent.insertBefore(panel, next);
    panel.classList.add('hidden');
    page = null;
    C.closeReceipt();
  }
  C.partnerSales = { render, load, leave };
}());
