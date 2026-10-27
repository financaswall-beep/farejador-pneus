(function () {
  'use strict';
  const C = window.Caixa, P = C.purchases, V = P.metalView, s = P.state, X = P.prices;
  const panel = document.getElementById('purchases-panel'), dialog = P.id('dialog');
  const active = () => !C.isPartner() && C.canModule('purchases') && !!C.token() && C.elements.app.classList.contains('is-matrix-purchases');
  let origin = null, lastTotals = null, engaged = false;
  const title = P.id('home').querySelector('.pc-intro h2');
  const repaint = (node, label, symbol) => node.replaceChildren(V.icon(symbol), V.el('span', '', label));
  repaint(P.id('new'), 'Nova compra', 'plus'); repaint(P.id('refresh'), '', 'refresh');
  P.id('home').querySelector('.pc-intro').appendChild(P.id('new'));
  P.id('search').parentElement.appendChild(P.id('refresh')); repaint(P.id('filter-toggle'), '', 'filter');
  const homeBack = V.button('', () => P.selectListTab('pending'), false, 'back'); homeBack.id = 'mp-prices-home-back'; homeBack.setAttribute('aria-label', 'Voltar às compras');
  P.id('home').querySelector('.pc-intro').prepend(homeBack);
  P.id('tab-prices').textContent = 'Comparar preços';
  P.id('tab-pending').firstChild.textContent = 'Para receber ';
  P.id('pending-count').nextElementSibling.textContent = 'Para receber';
  P.id('payable').nextElementSibling.textContent = 'A pagar';
  P.id('home').querySelectorAll(':scope > .pc-kpis > div').forEach((box, index) => {
    const values = box.querySelector('span'); values.prepend(values.lastElementChild); box.querySelector('svg').replaceWith(V.icon(index ? 'calendar' : 'box'));
  });
  const step1 = P.id('step-1'), amounts = P.id('purchased-date').closest('.pc-card');
  step1.querySelector('h3').textContent = 'Fornecedor'; P.id('supplier').closest('label').classList.add('mp-label-only');
  for (const [id, heading] of [['purchased-date', 'Data da compra'], ['reference', 'Referência do fornecedor']]) {
    const input = P.id(id), label = input.closest('label'), card = V.plate(heading); label.classList.add('mp-label-only'); card.appendChild(label); step1.appendChild(card);
  }
  const guidance = V.plate(null, 'mp-guidance'); guidance.append(V.icon('building'), V.el('div', '', 'Uma compra por fornecedor. Na próxima etapa você escolhe os pneus.')); step1.appendChild(guidance);
  amounts.querySelector('h3').textContent = 'Valores da compra';
  const productLine = V.row('Produtos', '—'); productLine.id = 'mp-review-products'; amounts.insertBefore(productLine, amounts.children[1]);
  amounts.appendChild(P.id('verified')); P.id('review-items').classList.add('mp-review-identity');
  const lotNote = V.el('p', 'pc-notice', 'A triagem dos modelos é feita no painel web.'); P.id('by-lot').appendChild(lotNote);
  P.id('lot-vehicle').querySelector('[value=mixed]').textContent = 'Carro e moto'; P.id('mode-items').textContent = 'Por pneus';
  P.id('change-supplier').textContent = 'Trocar'; P.id('catalog-search').placeholder = 'Buscar pneu por medida ou marca';
  P.id('pause').textContent = 'Salvar e sair';
  const receiptSelect = P.id('receipt-status'), receiptLabel = receiptSelect.closest('label'); receiptLabel.hidden = true;
  const arrival = V.el('div', 'mp-arrival'); arrival.setAttribute('role', 'group'); arrival.setAttribute('aria-label', 'A mercadoria já chegou?');
  [['pending', 'Ainda vai chegar'], ['received', 'Já chegou']].forEach(([value, label]) => {
    const b = V.button(label, () => { if (P.id('fields').disabled) return; receiptSelect.value = value; receiptSelect.dispatchEvent(new Event('input', { bubbles: true })); });
    b.dataset.receiptValue = value; arrival.appendChild(b);
  }); receiptLabel.before(arrival); receiptLabel.closest('.pc-card').querySelector('h3').textContent = 'A mercadoria já chegou?';
  const installmentEdit = V.el('details', 'mp-installments'), installmentSummary = V.el('div', 'mp-installment-summary');
  installmentEdit.append(V.el('summary', '', 'Editar parcelas'), P.id('installments')); P.id('add-installment').before(installmentSummary, installmentEdit);
  function updateInstallments() {
    const items = s.draft?.installments || [], hidden = !items.length || s.draft?.mode === 'lot'; installmentEdit.hidden = installmentSummary.hidden = hidden;
    installmentSummary.replaceChildren(...items.map((item, index) => V.row('Parcela ' + (index + 1) + ' · ' + P.day(item.due_date), item.amount === '' ? 'Preencha o valor' : P.money(item.amount))));
  }
  const nativeInstallments = P.renderInstallments;
  P.renderInstallments = function () { nativeInstallments(); updateInstallments(); if (s.draft?.installments.some(item => !item.due_date || !(Number(item.amount) > 0))) installmentEdit.open = true; };
  const nativeReview = P.renderReview;
  P.renderReview = function () {
    nativeReview(); if (!active()) return;
    const host = P.id('review-items'), lines = [...host.children].slice(1), detail = V.el('details', 'mp-review-lines');
    detail.append(V.el('summary', '', 'Ver pneus da compra'), ...lines);
    const name = host.firstElementChild; name.prepend(V.icon('building'));
    host.append(V.el('p', 'mp-review-quantity', ''), detail);
  };
  const nativePayment = P.renderPayment;
  P.renderPayment = function () {
    nativePayment(); arrival.querySelectorAll('button').forEach(b => { const selected = receiptSelect.value === b.dataset.receiptValue; b.classList.toggle('is-selected', selected); b.setAttribute('aria-pressed', String(selected)); b.disabled = P.id('fields').disabled; }); updateInstallments();
  };
  function totals(value) {
    lastTotals = value; if (!active()) return;
    productLine.querySelector('strong').textContent = P.money(value.products);
    const count = s.draft?.items.length || 0, label = value.quantity + (value.quantity === 1 ? ' pneu · ' : ' pneus · ') + (s.draft?.mode === 'lot' ? '1 lote' : count + (count === 1 ? ' item' : ' itens'));
    const quantity = P.id('review-items').querySelector('.mp-review-quantity'); if (quantity) quantity.textContent = label;
    if (s.draft?.step > 1) P.id('total-items').textContent = label;
  }
  const nativeFooter = P.footer;
  P.footer = function () {
    nativeFooter(); if (!s.draft || !active()) return;
    if (!s.busy && !s.pending) repaint(P.id('continue'), s.draft.step === 1 ? 'Escolher pneus' : s.draft.step === 2 ? 'Continuar para revisão' : s.preview ? 'Registrar compra' : 'Conferir valores', s.draft.step === 3 && s.preview ? 'check' : 'next');
    P.id('wizard').dataset.pendingAttempt = String(!!s.pending); updateInstallments();
  };
  const nativeStep = P.renderStep;
  P.renderStep = function () {
    nativeStep(); if (!s.draft || !active()) return;
    const step = s.draft.step; P.id('wizard').dataset.purchaseStep = step;
    P.id('wizard').querySelector('h2').textContent = step === 1 ? 'Nova compra' : step === 2 ? s.draft.mode === 'lot' ? 'Lote fechado' : 'Pneus da compra' : 'Revisar compra';
    if (step === 1) { P.reviewFields.forEach(key => { P.id(key).value = s.draft.review[key] ?? ''; }); P.id('purchased-date').max = P.today(); }
    if (!s.draft.newSupplier) P.id('supplier-new-toggle').textContent = '+ Cadastrar fornecedor';
    if (lastTotals) totals(lastTotals); layout(); panel.scrollTop = 0;
  };
  const vehicleFilters = V.el('nav', 'mp-vehicle-filters'); vehicleFilters.setAttribute('aria-label', 'Tipo de pneu');
  [['', 'Todos'], ['motorcycle', 'Moto'], ['car', 'Carro']].forEach(([value, label]) => {
    const b = V.button(label, () => { X.vehicleFilter = value; X.renderList(); }); b.dataset.vehicle = value; vehicleFilters.appendChild(b);
  }); X.id('search').after(vehicleFilters);
  const extraFilters = V.el('details', 'mp-extra-filters'); extraFilters.append(V.el('summary', '', 'Marca e condição'), X.id('brand').parentElement); vehicleFilters.after(extraFilters);
  const historyNote = V.el('p', 'pc-notice', 'Somente compras recebidas. Custos anteriores, sem frete e desconto.'); extraFilters.after(historyNote);
  const pricesHead = X.id('detail-heading'), back = X.id('back'), heading = V.el('header', 'mp-page-heading'); heading.append(back, V.el('h2', '', 'Custo do pneu')); pricesHead.prepend(heading);
  const supplierHeading = X.id('suppliers').previousElementSibling, supplierBox = V.plate(null, 'mp-supplier-comparison'); supplierHeading.textContent = 'Média por fornecedor'; supplierHeading.before(supplierBox); supplierBox.append(supplierHeading, X.id('suppliers'));
  const nativePriceList = X.renderList;
  X.renderList = function () { nativePriceList(); vehicleFilters.querySelectorAll('button').forEach(b => { const selected = b.dataset.vehicle === (X.vehicleFilter || ''); b.classList.toggle('is-selected', selected); b.setAttribute('aria-pressed', String(selected)); }); };
  const nativePriceDetail = X.renderDetail;
  X.renderDetail = function () {
    nativePriceDetail(); if (!active() || !X.group()) return;
    X.id('suppliers').querySelectorAll('.pp-supplier-card').forEach((button, index) => {
      const row = X.group().suppliers[index]; button.querySelector('.pp-supplier-cost strong').textContent = P.money(row.avg_cost);
      button.setAttribute('aria-label', row.supplier_name + ', custo médio de ' + P.money(row.avg_cost) + ' por pneu');
    });
    const supplier = X.group().suppliers.find(row => row.supplier_id === X.supplier);
    X.id('chart').closest('.pc-card').querySelector('h3').textContent = 'Histórico · ' + (supplier?.supplier_name || 'Fornecedor');
    X.id('use').textContent = 'Usar como referência'; X.id('total').previousElementSibling.textContent = 'Total pela média';
  };
  const nativeSelectTab = P.selectListTab, nativePriceShow = X.show;
  P.selectListTab = function (...args) { if (args[0] === 'prices' && s.tab !== 'prices') { X.selected = null; X.supplier = null; } nativeSelectTab(...args); layout(); if (active()) panel.scrollTop = 0; };
  X.show = function (...args) { nativePriceShow(...args); layout(); if (active()) panel.scrollTop = 0; };
  function layout() {
    if (!active()) return;
    const wizard = !P.id('wizard').hidden; panel.dataset.purchaseView = wizard ? 'wizard' : s.tab !== 'prices' ? 'list' : X.selected && X.group() ? 'price-detail' : 'prices';
    panel.dataset.pendingAttempt = String(!!s.pending);
    title.textContent = s.tab === 'prices' ? 'Comparar preços' : 'Compras'; homeBack.hidden = s.tab !== 'prices';
  }
  function catalogs() { return [...document.querySelectorAll('dialog[data-catalog-page][open]')]; }
  function syncPanel() { panel.inert = active() && (dialog.open || catalogs().length > 0); }
  function showDetail() { origin = document.activeElement; dialog.setAttribute('aria-modal', 'false'); dialog.show(); syncPanel(); dialog.querySelector('header button')?.focus({ preventScroll: true }); }
  function blockNavigation(tab) {
    if (!active() || s.session !== C.sessionFingerprint()) return false;
    if (s.busy || (tab !== 'purchases' && catalogs().some(page => !page.dispatchEvent(new Event('cancel', { cancelable: true }))))) { C.showToast('Salvando. Aguarde a conclusão para trocar de aba.'); return true; } return false;
  }
  function sync(tab) {
    if (s.session && s.session !== C.sessionFingerprint()) P.reset();
    if (tab !== 'purchases') {
      if (engaged) { P.persist(); dialog.close(); catalogs().forEach(page => page.close()); C.matrixCatalog.reset?.(); }
      engaged = false; panel.inert = false; return;
    }
    engaged = active();
    syncPanel(); layout();
  }
  function lockDetail() { dialog.querySelectorAll('.pc-stepper button').forEach(b => { b.disabled = !!b.parentElement.querySelector('input')?.disabled; }); }
  dialog.addEventListener('close', () => { syncPanel(); if (active() && origin?.isConnected && !panel.inert) origin.focus({ preventScroll: true }); origin = null; });
  document.addEventListener('close', syncPanel, true);
  new MutationObserver(syncPanel).observe(document.getElementById('matrix-catalog-editor'), { attributes: true, attributeFilter: ['open'] });
  document.addEventListener('keydown', event => {
    if (!active() || event.key !== 'Escape' || !dialog.open || catalogs().length) return;
    event.preventDefault(); if (dialog.dispatchEvent(new Event('cancel', { cancelable: true }))) dialog.close();
  });
  P.id('detail-close').replaceChildren(V.icon('back')); P.id('detail-close').setAttribute('aria-label', 'Voltar às compras');
  const nativeReset = P.reset;
  P.reset = function () { if (engaged) { catalogs().forEach(page => page.close()); C.matrixCatalog.reset?.(); } nativeReset(); lastTotals = null; origin = null; engaged = false; panel.inert = false; };
  P.metal = C.purchasesMetal = { active, sync, showDetail, totals, blockNavigation, lockDetail, syncPanel };
}());
