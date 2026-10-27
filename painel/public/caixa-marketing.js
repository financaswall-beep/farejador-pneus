(function () {
  'use strict';
  const C = window.Caixa, panel = document.getElementById('marketing-panel');
  panel.innerHTML = window.MATRIX_MARKETING_TEMPLATE;
  const M = C.marketing = { pages: {}, state: { page: 'home', filter: 'scheduled', ready: false, busy: false, month: '', day: '', network: 'all', period: '7d', sort: 'views', selected: null, detail: null, metrics: null, results: null, window: '7d' } };
  M.el = id => document.getElementById('mk-' + id);
  M.allowed = () => Boolean(C.token() && C.scope() === 'matrix' && C.stored(C.keys.role) === 'owner');
  M.active = () => M.allowed() && C.elements.app.classList.contains('is-matrix-marketing');
  const reads = new Set(); let fingerprint = '', timer, progressTimer, sequence = 0;
  const create = () => {
    const p = { ...window.PAINEL_MODULES.marketingPublisher(), ...window.PAINEL_MODULES.marketingPublisherMedia() };
    const session = C.sessionFingerprint();
    const request = (...args) => p === M.publisher && session === C.sessionFingerprint() ? M.request(...args) : Promise.reject(Error('invalid_session'));
    p.apiGet = path => request(path);
    p.apiPost = (path, body) => request(path, 'POST', body);
    p.apiPut = (path, body) => request(path, 'PUT', body);
    p.marketingIsMock = () => false; p.$nextTick = fn => Promise.resolve().then(fn);
    p.mpTusLibraryUrl = '/operacao/vendor/publisher-tus-4.3.1.min.js';
    p.mpFresh(); return p;
  };
  M.publisher = create();
  M.request = async (path, method = 'GET', body) => {
    if (!M.allowed() || !path.startsWith('/admin/api/marketing/')) throw Error('invalid_session');
    const session = C.sessionFingerprint(), controller = new AbortController();
    if (method === 'GET') reads.add(controller);
    try {
      const response = await C.authenticatedFetch(path.replace('/admin/api/marketing/', '/api/caixa/marketing/'), {
        method, signal: controller.signal, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      });
      const data = await C.json(response);
      if (controller.signal.aborted || C.sessionFingerprint() !== session || !M.allowed()) throw Error('invalid_session');
      if (!response.ok) throw Error(data.error || 'publisher_unavailable');
      return data;
    } finally { reads.delete(controller); }
  };
  M.busy = () => Boolean(M.state.busy || M.publisher.mpBusy || M.publisher.mpUploadBusy || M.publisher.mpAiBusy || M.publisher.mpConnectionBusy);
  const dirty = () => ['compose', 'review'].includes(M.state.page) && M.publisher.mpDirty;
  function discard() {
    if (!dirty()) return true;
    if (!window.confirm('Há alterações não salvas. Sair sem salvar o rascunho?')) return false;
    M.publisher.mpFresh(); return true;
  }
  M.blockNavigation = tab => {
    if (!M.active()) return false;
    if (M.busy()) { C.showToast('Aguarde a confirmação da operação.'); return true; }
    return tab !== 'marketing' && !discard();
  };
  M.status = () => {
    const p = M.publisher;
    M.el('error').textContent = p.mpError; M.el('error').classList.toggle('hidden', !p.mpError);
    M.el('dialog-error').textContent = p.mpError; M.el('dialog-error').classList.toggle('hidden', !p.mpError);
    M.el('dialog-progress').classList.toggle('hidden', !M.busy());
    M.el('message').textContent = p.mpMessage; M.el('message').classList.toggle('hidden', !p.mpMessage);
    M.el('loading').classList.toggle('hidden', !p.mpLoading);
    panel.setAttribute('aria-busy', String(M.busy()));
    const upload = p.mpUploadBusy; M.el('upload-progress').classList.toggle('hidden', !upload);
    M.el('upload-name').textContent = p.mpUploadName; M.el('upload-phase').textContent = p.mpUploadPhase;
    M.el('upload-bar').value = p.mpUploadProgress || 0;
    panel.querySelectorAll('button,input,textarea,select').forEach(control => { control.disabled = M.busy() || control.dataset.mkDisabled === 'true'; });
    M.el('save').disabled = M.busy(); M.el('continue').disabled = M.busy(); M.el('submit').disabled = M.busy() || !p.mpConfig?.sending;
  };
  M.render = () => {
    if (!M.active()) return;
    const page = M.state.page, form = ['compose', 'review'].includes(page), detail = ['insights', 'sales', 'history'].includes(page);
    panel.querySelectorAll('.mk-page').forEach(el => el.classList.add('hidden'));
    M.el(page === 'library' ? 'library-page' : page).classList.remove('hidden');
    M.el('title').textContent = ({ compose: 'Nova publicação', review: 'Revisar publicação', insights: 'Resultado do conteúdo', sales: 'Vendas deste conteúdo', history: 'Evolução das visualizações', library: 'Biblioteca', connections: 'Contas conectadas' })[page] || 'Marketing';
    M.el('tabs').classList.toggle('hidden', form || detail || ['library', 'connections'].includes(page));
    M.el('back').classList.toggle('hidden', ['home', 'calendar', 'results'].includes(page));
    M.el('save').classList.toggle('hidden', !form); M.el('settings').classList.toggle('hidden', form || detail);
    M.el('step').classList.toggle('hidden', !form); M.el('step').textContent = page === 'compose' ? '1 de 2 · Conteúdo' : '2 de 2 · Onde e quando';
    M.el('form-actions').classList.toggle('hidden', !form);
    M.el('continue').classList.toggle('hidden', page !== 'compose'); M.el('submit').classList.toggle('hidden', page !== 'review');
    document.querySelectorAll('[data-mk-tab]').forEach(b => b.setAttribute('aria-current', b.dataset.mkTab === page ? 'page' : 'false'));
    document.querySelectorAll('[data-mk-detail]').forEach(b => b.setAttribute('aria-current', b.dataset.mkDetail === page ? 'page' : 'false'));
    M.pages[page]?.(); M.status();
  };
  M.run = async (action, lock = true) => {
    if (M.busy()) return;
    const session = C.sessionFingerprint(), p = M.publisher;
    M.state.busy = lock; p.mpError = ''; M.status();
    const interval = setInterval(M.status, 200); progressTimer = interval;
    try { await action(); }
    catch (error) { if (p === M.publisher && error.message !== 'invalid_session' && error.name !== 'AbortError') p.mpError = p.mpErrorText(error); }
    finally {
      clearInterval(interval);
      if (p === M.publisher && session === C.sessionFingerprint()) { M.state.busy = false; M.render(); }
    }
  };
  M.load = async () => {
    if (!M.active()) return;
    const p = M.publisher, session = C.sessionFingerprint(); M.status();
    await p.mpLoad();
    if (p !== M.publisher || session !== C.sessionFingerprint() || !M.active()) return;
    M.state.ready = true; M.render();
    if (M.state.page === 'results') await M.loadResults?.();
    if (['insights', 'sales', 'history'].includes(M.state.page) && M.state.selected) await M.loadDetail?.();
    clearTimeout(timer);
    if (p.mpPosts.some(post => ['scheduled', 'publishing'].includes(post.status))) timer = setTimeout(() => {
      if (M.active() && !M.busy() && ['home', 'calendar'].includes(M.state.page)) void M.load();
    }, 15000);
  };
  const hashes = { home: '', calendar: '/agenda', results: '/resultados', compose: '/criar', review: '/revisar', library: '/biblioteca', connections: '/contas' };
  M.go = (page, options = {}) => {
    if (!M.active() || M.busy()) return;
    if (!['compose', 'review', 'library'].includes(page) && !options.keep && !discard()) return;
    M.closeDialog?.();
    if (page !== M.state.page) { M.publisher.mpMessage = ''; M.publisher.mpError = ''; }
    M.state.page = page;
    if (!options.history) {
      const suffix = ['insights', 'sales', 'history'].includes(page) ? '/' + page + '/' + encodeURIComponent(M.state.selected?.key || '') : hashes[page];
      history.pushState(null, '', '#marketing' + suffix);
    }
    M.el('content').scrollTop = 0; M.render();
    if (page === 'results' && !M.state.results) void M.loadResults?.();
    if (page === 'connections') void M.run(() => M.publisher.mpCheckConnections());
  };
  function fromHash() {
    const path = location.hash.slice('#marketing'.length).split('/').filter(Boolean);
    const page = Object.keys(hashes).find(key => hashes[key] === '/' + (path[0] || '')) || (path.length ? path[0] : 'home');
    if (['insights', 'sales', 'history'].includes(page) && path[1]) M.state.selected = { key: decodeURIComponent(path[1]) };
    M.state.page = Object.hasOwn(hashes, page) || ['insights', 'sales', 'history'].includes(page) ? page : 'home';
  }
  M.leave = () => {
    clearTimeout(timer); clearInterval(progressTimer); ++sequence;
    reads.forEach(c => c.abort()); reads.clear(); M.publisher.mpClose(); M.closeDialog?.();
  };
  M.reset = () => {
    M.leave(); fingerprint = ''; M.publisher = create();
    Object.assign(M.state, { page: 'home', ready: false, busy: false, selected: null, detail: null, metrics: null, results: null, detailLoading: false, detailError: false, resultsLoading: false });
    M.clearSales?.();
    panel.querySelectorAll('input:not([type=file]),textarea').forEach(input => { input.value = ''; });
    ['posts', 'calendar-posts', 'results-posts', 'results-summary', 'insights-post', 'insights-values', 'sales-post', 'sales-summary', 'sales-list', 'history-post', 'history-chart', 'history-data', 'library-items', 'connections-list', 'dialog-body', 'media-preview', 'review-preview'].forEach(id => M.el(id).replaceChildren());
  };
  M.sync = tab => {
    if (tab !== 'marketing' || !M.allowed()) {
      if (fingerprint) M.leave();
      if (location.hash.startsWith('#marketing')) history.replaceState(null, '', location.pathname + location.search);
      return;
    }
    if (fingerprint !== C.sessionFingerprint()) { M.reset(); fingerprint = C.sessionFingerprint(); }
    if (!location.hash.startsWith('#marketing')) history.replaceState(null, '', '#marketing');
    fromHash(); M.render(); void M.load();
  };
  M.nextRequest = () => ++sequence; M.isCurrent = id => id === sequence && M.active();
  document.querySelectorAll('[data-mk-tab]').forEach(button => button.addEventListener('click', () => M.go(button.dataset.mkTab)));
  M.el('back').addEventListener('click', () => M.go(({ review: 'compose', compose: 'home', library: M.state.libraryReturn || 'home', sales: 'insights', history: 'insights', insights: 'results' })[M.state.page] || 'home'));
  M.el('settings').addEventListener('click', () => M.go('connections'));
  M.el('connections-home').addEventListener('click', () => M.go('connections'));
  M.el('refresh').addEventListener('click', () => { if (!M.busy()) void M.load(); });
  M.el('connections-refresh').addEventListener('click', () => void M.run(() => M.publisher.mpCheckConnections()));
  document.getElementById('nav-marketing').addEventListener('click', () => {
    if (!M.allowed()) return;
    if (M.active()) M.go('home'); else C.showTab('marketing');
  });
  document.addEventListener('click', event => {
    if (!M.active()) return;
    const button = event.target.closest('.bottom-nav button[data-tab],#notifications-button,#operator-button');
    if (button && M.blockNavigation(button.dataset.tab || 'profile')) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  window.addEventListener('beforeunload', event => { if (M.active() && (M.busy() || dirty())) { event.preventDefault(); event.returnValue = ''; } });
  window.addEventListener('hashchange', () => { if (location.hash.startsWith('#marketing') && M.allowed()) C.showTab('marketing'); });
}());
