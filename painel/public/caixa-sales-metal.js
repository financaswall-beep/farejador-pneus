(function () {
  'use strict';
  const C = window.Caixa, panel = C.elements.salesPanel;
  const parent = panel.parentNode, next = panel.nextSibling;
  const week = C.elements.weeklyPrev.parentNode;
  const weekParent = week.parentNode, weekNext = week.nextSibling;
  let page = null;

  // Reaproveita controles, listeners e dados do motor de vendas existente.
  function leave() {
    if (!page) return;
    weekParent.insertBefore(week, weekNext);
    parent.insertBefore(panel, next);
    page.remove(); page = null;
  }
  function sync(tab) {
    if (C.isPartner() || tab !== 'sales' || !C.canModule('vendas')) { leave(); return; }
    if (page) return;
    page = document.createElement('section'); page.className = 'ps-sales ms-sales';
    page.setAttribute('aria-label', 'Vendas');
    const heading = document.createElement('header'); heading.className = 'ps-screen-heading';
    const title = document.createElement('h3'); title.textContent = 'Vendas';
    heading.append(title, week); page.appendChild(heading);
    parent.insertBefore(page, panel); page.appendChild(panel);
  }
  C.matrixSalesScreen = { sync, leave };
}());
