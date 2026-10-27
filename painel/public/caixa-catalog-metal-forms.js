(function () {
  'use strict';
  const C = window.Caixa, V = C.catalogMetalView, el = id => document.getElementById(id);
  const origins = new WeakMap();
  const pages = () => [...document.querySelectorAll('dialog[data-catalog-page][open]')];
  const stockPage = () => el('stock-price-modal').classList.contains('mcg-stock-price') && !el('stock-price-modal').classList.contains('hidden');
  const active = () => C.matrixCatalogMetal?.isActive() || C.purchasesMetal?.active();
  function syncPanel() { C.elements.catalogPanel.inert = Boolean(C.matrixCatalogMetal?.isActive() && (pages().length || stockPage())); C.purchasesMetal?.syncPanel(); }
  const watchedPages = new WeakSet(), pageObserver = new MutationObserver(syncPanel);
  pageObserver.observe(el('stock-price-modal'), { attributes: true, attributeFilter: ['class'] });
  function show(dialog) {
    if (dialog.open) return;
    if (!dialog.classList.contains('mcg-dialog') || !active()) {
      delete dialog.dataset.catalogPage; dialog.removeAttribute('aria-modal'); dialog.showModal(); return;
    }
    // A tela ocupa só o conteúdo; cabeçalho e navegação continuam acessíveis.
    origins.set(dialog, document.activeElement); dialog.dataset.catalogPage = 'true';
    if (!watchedPages.has(dialog)) { pageObserver.observe(dialog, { attributes: true, attributeFilter: ['open'] }); watchedPages.add(dialog); }
    dialog.setAttribute('aria-modal', 'false'); dialog.show(); syncPanel();
  }
  function canClose(dialog) { return dialog.dispatchEvent(new Event('cancel', { cancelable: true })); }
  document.addEventListener('close', event => {
    if (!event.target.dataset?.catalogPage) return;
    syncPanel(); const origin = origins.get(event.target); origins.delete(event.target);
    if (origin?.isConnected && origin.getClientRects().length && !C.elements.catalogPanel.inert) origin.focus({ preventScroll: true });
  }, true);
  document.addEventListener('keydown', event => {
    const page = pages().at(-1);
    if (event.key !== 'Escape' || event.defaultPrevented || !page || document.querySelector('dialog:modal')) return;
    event.preventDefault(); event.stopImmediatePropagation(); if (canClose(page)) page.close();
  });
  document.addEventListener('click', event => {
    if (!C.matrixCatalogMetal?.isActive() || !event.target.closest('.bottom-nav > button,.sales-header button')) return;
    if (pages().every(canClose) && !(stockPage() && C.stockPriceBusy?.())) return;
    event.preventDefault(); event.stopImmediatePropagation(); C.showToast('Salvando. Aguarde a conclusão para trocar de aba.');
  }, true);
  function frame(dialog) {
    const enabled = Boolean(active());
    dialog.classList.toggle('mcg-dialog', enabled); dialog.classList.toggle('is-matrix-metal', enabled);
    if (enabled) {
      const back = dialog.querySelector('header > button'); if (back) { back.innerHTML = V.iconHTML('back'); back.setAttribute('aria-label', 'Voltar'); }
    }
    return enabled;
  }
  function product(dialog, row) {
    dialog.querySelector('.mcg-editor-product')?.remove();
    if (!row) return;
    const n = V.identity(row, true); n.classList.add('mcg-editor-product'); dialog.querySelector('header').after(n);
  }
  function prepareEditor() {
    const details = document.createElement('details'); details.id = 'mcg-extra-spec';
    const summary = V.el('summary', 'Mais dados técnicos'), fields = V.el('div', null, 'matrix-catalog-grid mcg-extra-fields');
    details.append(summary, fields);
    const first = el('matrix-catalog-tread').closest('label'); first.before(details);
    ['tread', 'load', 'speed'].forEach(name => fields.appendChild(el('matrix-catalog-' + name).closest('label')));
    const initial = el('matrix-catalog-initial-price-label'), price = V.el('fieldset'); price.id = 'mcg-initial-price-group';
    price.append(V.el('legend', 'Preço de venda'), initial); el('matrix-catalog-form').querySelector(':scope > .matrix-catalog-note').before(price);
    el('matrix-catalog-price-form').appendChild(V.el('p', 'O novo preço vale para as próximas vendas.', 'mcg-hint'));
  }
  prepareEditor();
  function editor(row, requestedMode) {
    const dialog = el('matrix-catalog-editor'); if (!frame(dialog)) return;
    const editing = Boolean(row?.product_id), mode = editing ? requestedMode === 'price' ? 'price' : 'spec' : 'create'; dialog.dataset.catalogForm = mode;
    product(dialog, row);
    el('matrix-catalog-form').classList.toggle('hidden', mode === 'price');
    el('matrix-catalog-price-form').classList.toggle('hidden', mode !== 'price');
    el('matrix-catalog-fitments-open').classList.add('hidden');
    el('matrix-catalog-form').querySelector(':scope > .matrix-catalog-note').textContent = editing ? 'As alterações valem no app e no painel.' : 'O cadastro não adiciona quantidade ao estoque.';
    el('matrix-catalog-title').textContent = mode === 'price' ? 'Alterar preço' : editing ? 'Ficha técnica' : row?.creation_mode === 'stock' ? 'Completar cadastro' : 'Cadastrar pneu';
    el('matrix-catalog-identity').classList.toggle('mcg-hide-identity', editing);
    el('mcg-initial-price-group').classList.toggle('hidden', editing);
    el('matrix-catalog-measure-help').textContent = row?.creation_mode === 'stock'
      ? 'Medida, marca e condição seguem o item de estoque.'
      : 'Escolha uma medida cadastrada ou digite uma nova. Ex.: 90/90-18.';
    el('mcg-extra-spec').open = editing;
    const old = dialog.querySelector('.mcg-current-price'); old?.remove();
    if (mode === 'price') {
      const box = V.plate('mcg-current-price'); box.append(V.el('small', 'Preço atual'), V.el('strong', C.operationCatalogUtils.priceLabel(row)));
      el('matrix-catalog-price-form').before(box);
    }
  }
  function fitment(state) {
    const dialog = el('matrix-fitments'); if (!frame(dialog)) return;
    const view = dialog.dataset.fitmentView || 'list'; dialog.dataset.fitmentView = view;
    product(dialog, state.row);
    el('matrix-fitments-title').textContent = view === 'list' ? 'Compatibilidade' : view === 'remove' ? 'Remover vínculo' : state.action === 'edit' ? 'Ajustar vínculo' : 'Vincular veículo';
    let add = el('mcg-fitment-add');
    if (!add) { add = V.button('Vincular veículo', 'fitment-add', 'primary', 'plus'); add.id = 'mcg-fitment-add'; add.addEventListener('click', () => C.matrixCatalogFitments.add()); el('matrix-fitments-list').after(add); }
    add.hidden = view !== 'list' || !C.matrixCatalog.allowed() || !state.row?.product_id || !state.row?.vehicle_type;
    el('matrix-fitments-reset').textContent = view === 'remove' ? 'Manter vínculo' : 'Voltar aos vínculos';
    el('matrix-fitments-save').classList.toggle('mcg-danger', view === 'remove');
    el('matrix-fitments-scope').textContent = state.row?.vehicle_type === 'motorcycle' ? 'Em motos, o vínculo vale para a mesma medida e categoria.' : 'Em carros, o vínculo vale somente para este produto.';
    el('matrix-fitments-selected').classList.toggle('mcg-selected-vehicle', Boolean(state.vehicle));
  }
  C.catalogMetalForms = { editor, fitment, show, syncPanel };
}());
