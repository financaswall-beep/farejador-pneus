(function () {
  'use strict';
  const C = window.Caixa, V = C.matrixStockView, panel = document.getElementById('stock-panel');
  const host = V.el('section'); host.id = 'matrix-stock-metal'; panel.appendChild(host);
  const priceModal = document.getElementById('stock-price-modal');
  const m = { active: false, session: '', view: 'list', rows: [], loaded: false, loading: false, error: false,
    query: '', filter: 'all', condition: '', vehicle: '', brand: '', limit: 20,
    stock: null, items: [], page: 1, hasMore: false, days: '30', request: 0 };
  let inflight = null, generation = 0, trigger = null;
  const valid = () => m.active && !C.isPartner() && C.canModule('estoque') && !!C.token() && m.session === C.sessionFingerprint();
  function render(focus) {
    if (!valid()) return;
    const scroll = panel.scrollTop;
    let page;
    if (m.view === 'list') page = V.list(m);
    else if (m.view === 'filters') page = V.filters(m);
    else if (m.view === 'reservations') page = V.reservations(m);
    else if (m.view === 'history') page = V.history(m);
    else if (m.stock) {
      page = V.detail(m.stock);
      if (m.loading || m.error) { page = V.el('div', null, 'mcg-page ms-page'); page.append(V.button('Voltar', 'list', 'secondary', 'back'), V.el('p', m.error ? 'Não foi possível carregar o pneu.' : 'Carregando pneu…', 'mcg-notice')); if (m.error) page.appendChild(V.button('Tentar novamente', 'reload', 'primary')); }
    } else page = V.list(m);
    host.replaceChildren(page); panel.dataset.stockView = m.view; panel.scrollTop = scroll;
    if (focus) { panel.scrollTop = 0; host.querySelector('h2')?.focus({ preventScroll: true }); }
  }
  async function request(path) {
    const response = await C.authenticatedFetch(C.operationPath('operacao/estoque' + path));
    const data = await C.json(response); if (!response.ok) throw new Error(data.error || 'request_failed'); return data;
  }
  async function load() {
    if (!valid()) return;
    if (inflight) return inflight;
    const session = m.session, version = generation;
    m.loading = true; m.error = false; render();
    inflight = (async () => {
      try {
        const data = await request('');
        if (!valid() || version !== generation || session !== m.session) return;
        m.rows = data.rows || []; C.stockState.rows = m.rows; m.loaded = true;
        if (m.stock) m.stock = m.rows.find(row => row.stock_id === m.stock.stock_id) || null;
        if (!m.stock && !['list', 'filters'].includes(m.view)) m.view = 'list';
      } catch (error) { if (valid() && version === generation && error.message !== 'invalid_session') m.error = true; }
      finally { if (version === generation) { inflight = null; m.loading = false; render(); } }
    })(); return inflight;
  }
  async function loadDetail(id) {
    if (!valid()) return;
    const requestId = ++m.request, session = m.session;
    m.view = 'detail'; m.items = []; m.error = false; m.loading = true; render(true);
    try {
      const data = await request('/' + encodeURIComponent(id));
      if (!valid() || requestId !== m.request || session !== m.session) return;
      m.stock = data.stock;
    } catch (error) { if (valid() && requestId === m.request && error.message !== 'invalid_session') m.error = true; }
    finally { if (valid() && requestId === m.request) { m.loading = false; render(true); } }
  }
  async function loadRemote(append) {
    if (!valid() || !m.stock) return;
    const view = m.view, id = m.stock.stock_id, version = ++m.request, page = append ? m.page + 1 : 1, session = m.session;
    m.loading = true; m.error = false; if (!append) m.items = []; render();
    try {
      const suffix = view === 'reservations' ? 'reservas' : 'movimentacoes';
      const data = await request('/' + encodeURIComponent(id) + '/' + suffix + '?page=' + page + '&days=' + m.days);
      if (!valid() || version !== m.request || session !== m.session || view !== m.view) return;
      const payload = view === 'reservations' ? data.reservations : data.history;
      m.stock = data.stock; m.items = append ? m.items.concat(payload.rows || []) : payload.rows || [];
      m.page = page; m.hasMore = !!payload.has_more;
    } catch (error) { if (valid() && version === m.request && error.message !== 'invalid_session') m.error = true; }
    finally { if (valid() && version === m.request) { m.loading = false; render(); } }
  }
  function list() {
    ++m.request; m.loading = false; m.error = false; m.view = 'list'; render(true);
    if (trigger) host.querySelector('[data-stock-id="' + trigger + '"]')?.focus({ preventScroll: true });
  }
  function sync(tab) {
    if (m.session && m.session !== C.sessionFingerprint()) reset();
    const active = tab === 'stock' && !C.isPartner() && C.canModule('estoque');
    if (!active && m.active) {
      ++generation; ++m.request; inflight = null; m.view = 'list'; m.loading = false;
      if (priceModal.classList.contains('ms-stock-price')) C.resetStockPrice();
      panel.inert = false;
    }
    m.active = active; m.session = C.sessionFingerprint();
    if (active) { render(); if (!m.loaded) void load(); }
  }
  function reset() {
    ++generation; ++m.request; inflight = null; m.active = false; m.session = ''; m.rows = []; m.items = []; m.stock = null;
    m.loaded = false; m.loading = false; m.error = false; m.view = 'list'; m.query = ''; m.filter = 'all'; m.condition = ''; m.vehicle = ''; m.brand = ''; m.limit = 20; C.stockState.rows = [];
    host.replaceChildren(); panel.inert = false; if (priceModal.classList.contains('ms-stock-price')) C.resetStockPrice();
  }
  host.addEventListener('click', event => {
    const b = event.target.closest('[data-ms-action]'); if (!b || b.disabled || !valid()) return;
    const action = b.dataset.msAction;
    if (action === 'list') list();
    else if (action === 'refresh') void load();
    else if (action === 'filters') { m.view = 'filters'; render(true); }
    else if (action === 'clear-filters') { m.filter = 'all'; m.condition = ''; m.vehicle = ''; m.brand = ''; m.query = ''; m.limit = 20; render(); }
    else if (action === 'filter') { m.filter = b.dataset.filter; m.limit = 20; render(); }
    else if (action === 'more') { m.limit += 20; render(); }
    else if (action === 'detail') { m.stock = m.rows.find(row => row.stock_id === b.dataset.stockId); trigger = b.dataset.stockId; if (m.stock) void loadDetail(m.stock.stock_id); }
    else if (action === 'detail-back') { ++m.request; m.loading = false; m.error = false; m.view = 'detail'; render(true); }
    else if (action === 'price' && m.stock && C.isOwner()) C.openStockPrice(m.stock);
    else if (action === 'reservations' || action === 'history') { m.view = action; m.hasMore = false; panel.scrollTop = 0; void loadRemote(false); }
    else if (action === 'next-page') void loadRemote(true);
    else if (action === 'reload') { if (m.view === 'detail') void loadDetail(m.stock.stock_id); else void loadRemote(false); }
    else if (action === 'order' && C.canModule('vendas')) void C.openReceipt(b.dataset.orderId, b);
    else if (action === 'catalog' && m.stock?.product_id) {
      const id = m.stock.product_id; C.showTab('catalog');
      void C.loadOperationCatalog(1).then(() => {
        if (C.matrixCatalogMetal.isActive()) { const row = C.operationCatalogState.rows.find(item => item.product_id === id); if (row) C.matrixCatalogMetal.open(row); }
      });
    }
  });
  host.addEventListener('input', event => { if (event.target.id === 'ms-search' && valid()) { m.query = event.target.value; m.limit = 20; V.fillCards(m, host.querySelector('#ms-cards')); } });
  host.addEventListener('change', event => { if (event.target.name === 'days' && valid()) { m.days = event.target.value; void loadRemote(false); } });
  host.addEventListener('submit', event => {
    if (event.target.id !== 'ms-filter-form' || !valid()) return;
    event.preventDefault(); const data = new FormData(event.target);
    for (const key of ['filter', 'condition', 'vehicle', 'brand']) m[key] = String(data.get(key) || '');
    m.limit = 20; list();
  });
  const previousPrice = C.openStockPrice;
  C.openStockPrice = function (row) {
    previousPrice(row); priceModal.classList.toggle('ms-stock-price', valid());
    if (!valid() || !C.isOwner()) return;
    priceModal.setAttribute('aria-modal', 'false'); panel.inert = true;
    document.getElementById('stock-price-title').textContent = 'Alterar preço';
    document.getElementById('stock-price-submit').textContent = 'Salvar preço';
    const image = priceModal.querySelector('#stock-price-illustration img');
    image.src = row.vehicle_type === 'car' ? '/operacao/catalog-tire-car.png' : '/operacao/catalog-tire.webp';
    image.hidden = !['car', 'motorcycle'].includes(row.vehicle_type);
  };
  new MutationObserver(() => {
    if (valid() && priceModal.classList.contains('ms-stock-price')) {
      const hidden = priceModal.classList.contains('hidden'); panel.inert = !hidden;
      if (hidden) host.querySelector('[data-ms-action=price]')?.focus({ preventScroll: true });
    }
  }).observe(priceModal, { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('click', event => {
    if (!valid() || !event.target.closest('.bottom-nav button,.sales-header button')) return;
    if (C.stockPriceBusy()) { event.preventDefault(); event.stopImmediatePropagation(); C.showToast('Salvando. Aguarde a conclusão para trocar de aba.'); }
    else if (priceModal.classList.contains('ms-stock-price')) { C.resetStockPrice(); panel.inert = false; }
  }, true);
  document.addEventListener('keydown', event => {
    if (!valid() || priceModal.contains(event.target) || !priceModal.classList.contains('hidden') || event.key !== 'Escape' || m.view === 'list') return;
    if (['history', 'reservations'].includes(m.view)) { ++m.request; m.loading = false; m.error = false; m.view = 'detail'; render(true); } else list();
  });
  C.matrixStock = { sync, reset, load };
}());
