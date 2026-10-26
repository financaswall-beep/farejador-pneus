(function () {
  'use strict';
  const C = window.Caixa, V = C.catalogMetalView, state = C.operationCatalogState, panel = C.elements.catalogPanel;
  const source = C.operationCatalogView, productContainer = document.getElementById('operation-catalog-list').parentElement;
  productContainer.id = 'mcg-products';
  const host = V.el('section'); host.id = 'matrix-catalog-metal'; productContainer.appendChild(host);
  const title = V.heading('Catálogo'); title.id = 'mcg-common-heading'; panel.prepend(title);
  const refresh = V.button('', 'refresh', 'icon-button', 'refresh'); refresh.setAttribute('aria-label', 'Atualizar catálogo'); title.appendChild(refresh);
  const filters = V.el('dialog', null, 'is-matrix-metal mcg-dialog'); filters.id = 'mcg-filters'; filters.setAttribute('aria-label', 'Filtrar catálogo'); document.body.appendChild(filters);
  const stockChoice = V.el('dialog', null, 'is-matrix-metal mcg-dialog'); stockChoice.id = 'mcg-stock-selector'; stockChoice.setAttribute('aria-label', 'Escolher item para alterar preço'); document.body.appendChild(stockChoice);
  let choiceRow = null;
  const m = { active: false, session: '', selected: '', media: false, page: 1 };
  const owner = () => C.matrixCatalog.allowed();
  const valid = () => m.active && !C.isPartner() && !!C.token() && C.canModule('estoque') && m.session === C.sessionFingerprint();
  const selected = () => state.rows.find(row => V.key(row) === m.selected);
  function reset() {
    m.active = false; m.session = ''; m.selected = ''; m.media = false; m.page = 1;
    state.request++; Object.assign(state, { rows: [], brands: [], summary: {}, loaded: false, loading: false, error: false, query: '', brand: '', filter: 'all' });
    filters.close(); filters.replaceChildren(); stockChoice.close(); stockChoice.replaceChildren(); choiceRow = null; host.replaceChildren(); panel.dataset.catalogView = 'products';
    title.querySelector('h2').textContent = 'Catálogo';
    C.matrixPhotoGallery.close(); C.matrixCatalog.reset?.(); C.matrixCatalogFitments?.reset(); source.closeStockSelection();
    if (document.getElementById('stock-price-modal').classList.contains('mcg-stock-price')) C.resetStockPrice();
  }
  function sync(tab) {
    if (m.session && m.session !== C.sessionFingerprint()) reset();
    m.session = C.sessionFingerprint(); m.active = tab === 'catalog' && !C.isPartner() && C.canModule('estoque');
    if (!m.active) { filters.close(); stockChoice.close(); source.closeStockSelection(); C.matrixCatalog.reset?.(); C.matrixCatalogFitments?.reset(); m.selected = ''; }
    else render();
  }
  function render() {
    if (!valid()) return;
    const row = selected(), same = host.dataset.product === m.selected, scroll = panel.scrollTop;
    const focus = host.contains(document.activeElement) ? document.activeElement.id : '';
    if (row && !state.loading && !state.error) { host.replaceChildren(V.detail(row)); panel.dataset.catalogView = 'detail'; }
    else if (m.selected && (state.loading || state.error)) {
      const page = V.el('div', null, 'mcg-page'); page.append(V.heading('Pneu do catálogo', 'products'), V.el('p', state.error ? 'Não foi possível atualizar o pneu.' : 'Atualizando cadastro…', 'mcg-notice'));
      if (state.error) page.appendChild(V.button('Tentar novamente', 'refresh', 'primary')); host.replaceChildren(page);
    } else { m.selected = ''; host.replaceChildren(V.list(m, state)); V.cards(m, state, host.querySelector('#mcg-product-list')); panel.dataset.catalogView = 'products'; }
    host.dataset.product = m.selected;
    if (m.media) panel.dataset.catalogView = C.matrixPhotoGallery.mediaView?.() || 'gallery';
    panel.scrollTop = same ? scroll : 0; if (focus) host.querySelector('#' + focus)?.focus({ preventScroll: true });
  }
  function open(row) { if (!valid() || !row) return; m.selected = V.key(row); render(); host.querySelector('h2')?.focus({ preventScroll: true }); }
  function openPrice(row) {
    if (!owner()) return;
    const U = C.operationCatalogUtils, entries = U.localEntries(row);
    if (!entries.length) return C.openMatrixCatalogEditor(row, 'price');
    if (entries.length === 1) return C.openStockPrice(U.selectedStockRow(row, entries[0]));
    choiceRow = row; stockChoice.replaceChildren(V.heading('Escolher item', 'close-stock-choice'), V.identity(row, true), V.el('p', 'Qual item terá o preço alterado?', 'mcg-notice'));
    entries.forEach((entry, index) => {
      const option = V.button('', 'select-stock', 'secondary'); option.dataset.index = index; option.classList.add('mcg-stock-option');
      option.replaceChildren(V.el('strong', entry.local_sku || entry.item_name || 'Item ' + (index + 1)), V.el('span', entry.shelf_location || 'Local não informado'), V.el('span', U.number(entry.quantity_available) + ' disponíveis'), V.el('b', entry.sale_price == null ? 'Preço não definido' : C.currency.format(Number(entry.sale_price)))); stockChoice.appendChild(option);
    });
    stockChoice.append(V.button('Voltar', 'close-stock-choice'), V.el('p', 'O preço será alterado somente no item escolhido.', 'mcg-hint')); stockChoice.showModal();
  }
  const previousPrice = C.openStockPrice;
  C.openStockPrice = function (row) {
    previousPrice(row);
    const modal = document.getElementById('stock-price-modal'); modal.classList.toggle('mcg-stock-price', valid()); modal.classList.toggle('is-matrix-metal', valid());
  };
  function showFilters() { filters.replaceChildren(V.filterForm(state)); filters.showModal(); }
  function act(event) {
    const b = event.target.closest('[data-mcg-action]'); if (!b || b.disabled || !valid()) return;
    const action = b.dataset.mcgAction, row = selected();
    if (action === 'products') { m.selected = ''; render(); }
    else if (action === 'refresh') { if (m.media) void C.matrixPhotoGallery.refresh(); else void C.loadOperationCatalog(1); }
    else if (action === 'filters') showFilters();
    else if (action === 'close-filters') filters.close();
    else if (action === 'close-stock-choice') stockChoice.close();
    else if (action === 'select-stock' && choiceRow && owner()) { const entry = C.operationCatalogUtils.localEntries(choiceRow)[Number(b.dataset.index)]; if (entry) { stockChoice.close(); C.openStockPrice(C.operationCatalogUtils.selectedStockRow(choiceRow, entry)); } }
    else if (action === 'clear-filters') filters.replaceChildren(V.filterForm({ ...state, query: '', brand: '', filter: 'all' }));
    else if (action === 'brand' || action === 'filter') { state[action === 'brand' ? 'brand' : 'filter'] = b.dataset[action]; m.page = 1; render(); }
    else if (action === 'more') { m.page++; render(); }
    else if (action === 'create' && owner()) C.openMatrixCatalogEditor(null);
    else if (action === 'detail' || action === 'complete') {
      const target = state.rows.find(item => V.key(item) === b.dataset.key);
      if (action === 'detail') open(target); else if (owner()) C.openMatrixCatalogEditor(target);
    } else if (row) {
      if (action === 'spec' && owner()) C.openMatrixCatalogEditor(row, 'spec');
      if (action === 'price') openPrice(row);
      if (action === 'fitments') void C.openMatrixCatalogFitments(row);
      if (action === 'media' && owner()) void C.matrixPhotoGallery.open(row.product_id);
    }
  }
  host.addEventListener('click', act); title.addEventListener('click', act); filters.addEventListener('click', act); stockChoice.addEventListener('click', act);
  host.addEventListener('input', event => { if (event.target.id === 'mcg-search' && valid()) { state.query = event.target.value; m.page = 1; V.cards(m, state, host.querySelector('#mcg-product-list')); } });
  filters.addEventListener('submit', event => { event.preventDefault(); if (!valid()) return; const data = new FormData(event.target); state.query = String(data.get('query') || '').trim(); state.brand = String(data.get('brand') || ''); state.filter = String(data.get('filter') || 'all'); m.page = 1; filters.close(); render(); });
  document.addEventListener('keydown', event => {
    if (!valid()) return;
    if (event.key === 'Escape') source.closeStockSelection();
    const modal = document.getElementById('stock-price-modal');
    if (event.key !== 'Tab' || !modal.classList.contains('mcg-stock-price') || modal.classList.contains('hidden')) return;
    const focusable = [...modal.querySelectorAll('.stock-price-sheet button,.stock-price-sheet input,.stock-price-sheet textarea')].filter(n => !n.disabled && n.offsetParent !== null);
    const target = event.shiftKey ? focusable.at(-1) : focusable[0];
    if (target && (!modal.contains(document.activeElement) || document.activeElement === (event.shiftKey ? focusable[0] : focusable.at(-1)))) { event.preventDefault(); target.focus(); }
  });
  C.operationCatalogView = Object.freeze({ ...source,
    render() { if (C.isPartner()) return source.render(); render(); },
    renderSummary(summary) { source.renderSummary(summary); },
    setLoading(append) { source.setLoading(append); render(); }, showError() { source.showError(); render(); },
  });
  C.matrixCatalogMetal = { sync, reset, isActive: valid, open,
    mediaChanged(mediaState) { m.media = Boolean(mediaState); if (!valid()) return; title.querySelector('h2').textContent = mediaState ? 'Fotos e vídeos' : 'Catálogo'; panel.dataset.catalogView = mediaState ? (mediaState.selected ? 'media-' + (mediaState.screen || 'photos') : 'gallery') : (m.selected ? 'detail' : 'products'); },
  };
}());
