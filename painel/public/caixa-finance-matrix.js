(function () {
  'use strict';
  const C = window.Caixa, V = C.financeView, el = id => document.getElementById(id);
  const state = { tab: 'summary', direction: 'all', search: '', offset: 0, limit: 25, payload: null, masked: false };
  let request = null, recentRequest = null, accountsRequest = null, timer = 0;
  const currentMonth = () => window.FarejadorTime.dateKey(new Date()).slice(0, 7);
  const hidden = (id, value) => el(id).classList.toggle('hidden', value);
  function period() {
    const input = el('mf-month');
    if (!input.value) input.value = currentMonth();
    input.max = currentMonth();
    if (!/^(?:20|21)\d{2}-(0[1-9]|1[0-2])$/.test(input.value) || input.value > input.max) throw Error('invalid_month');
    C.syncFinanceMonth(input.value);
    const label = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' })
      .format(new Date(input.value + '-01T12:00:00Z')).replace(' de ', ' ');
    el('mf-month-label').textContent = label.charAt(0).toUpperCase() + label.slice(1);
    return input.value;
  }
  function cancel() {
    if (request) request.abort(); if (recentRequest) recentRequest.abort();
    if (accountsRequest) accountsRequest.abort(); accountsRequest = null;
    request = null; recentRequest = null; clearTimeout(timer);
  }
  function valid(context) {
    return !context.controller.signal.aborted && C.sessionFingerprint() === context.session
      && !C.isPartner() && C.canModule('financeiro') && el('mf-month').value === context.month;
  }
  function context(controller) { return { controller, session: C.sessionFingerprint(), month: period() }; }
  async function fetchData(path, ctx) {
    const response = await C.authenticatedFetch(path, { signal: ctx.controller.signal });
    const body = await C.json(response);
    if (!response.ok) throw Error(response.status === 422 ? 'report_limit_reduce_period' : body.error || 'finance_unavailable');
    if (body.source !== 'central_ledger' || body.period !== ctx.month || !['green', 'yellow'].includes(body.integration_status)) throw Error('finance_payload_invalid');
    return body;
  }
  function errorText(error) {
    if (error.message === 'invalid_month') return 'Escolha um mês válido, até o mês atual.';
    if (error.message === 'report_limit_reduce_period') return 'O período ultrapassou o limite do relatório. Consulte um intervalo menor no Financeiro web.';
    return 'Não foi possível conferir os lançamentos do livro financeiro central. Tente atualizar novamente.';
  }
  function ignored(error, ctx) { return !valid(ctx) || error.name === 'AbortError' || error.message === 'invalid_session'; }
  function updated(date) {
    el('mf-updated').textContent = 'Atualizado às ' + new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }).format(date || new Date());
  }
  function validateRows(body) {
    if (!Array.isArray(body.rows) || !Number.isInteger(body.total) || body.total < 0) throw Error('finance_payload_invalid');
    body.rows.forEach(row => {
      if (typeof row.id !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.cash_on)) throw Error('finance_payload_invalid');
      V.number(row.cash_in); V.number(row.cash_out);
    });
  }
  async function loadRecent() {
    if (!C.token() || C.isPartner() || !C.canModule('financeiro')) return;
    if (recentRequest) recentRequest.abort();
    const controller = new AbortController(); recentRequest = controller;
    const ctx = context(controller);
    hidden('mf-recent-error', true); el('mf-recent').replaceChildren(V.node('p', 'Carregando movimentações…', 'mf-empty'));
    try {
      const body = await fetchData('/api/caixa/financeiro-extrato?' + new URLSearchParams({ period: ctx.month, limit: '1' }), ctx);
      if (!valid(ctx)) return;
      validateRows(body); V.movements('mf-recent', body.rows, true, false);
    } catch (error) {
      if (ignored(error, ctx)) return;
      el('mf-recent').replaceChildren(); hidden('mf-recent-error', false);
    } finally { if (recentRequest === controller) recentRequest = null; }
  }
  async function loadSummary() {
    cancel();
    const controller = new AbortController(); request = controller;
    let ctx;
    hidden('mf-summary', true); hidden('mf-statement', true); hidden('mf-error', true); hidden('mf-loading', false);
    el('mf-updated').textContent = ''; state.payload = null;
    try {
      ctx = context(controller);
      const body = await fetchData('/api/caixa/financeiro-simples?period=' + encodeURIComponent(ctx.month), ctx);
      if (!valid(ctx)) return;
      if (!body.truth || !Array.isArray(body.expenses)) throw Error('finance_payload_invalid');
      V.summary(body, currentMonth()); state.payload = body;
      hidden('mf-summary', false); hidden('mf-loading', true); updated();
      await loadRecent();
    } catch (error) {
      if (ctx && ignored(error, ctx)) return;
      hidden('mf-loading', true); hidden('mf-summary', true); hidden('mf-error', false);
      el('mf-error-copy').textContent = errorText(error);
    } finally { if (request === controller) request = null; }
  }
  async function loadStatement() {
    cancel();
    const controller = new AbortController(); request = controller;
    let ctx;
    hidden('mf-summary', true); hidden('mf-loading', true); hidden('mf-error', true); hidden('mf-statement', false);
    hidden('mf-list-loading', false); hidden('mf-list-error', true); hidden('mf-statement-results', true);
    hidden('mf-statement-balances', true); hidden('mf-statement-warning', true);
    el('mf-updated').textContent = '';
    document.querySelectorAll('[data-mf-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mfFilter === state.direction)));
    hidden('mf-search-clear', !el('mf-search').value);
    try {
      ctx = context(controller);
      const body = await fetchData('/api/caixa/financeiro-extrato?' + new URLSearchParams({
        period: ctx.month, search: state.search, direction: state.direction, limit: String(state.limit), offset: String(state.offset),
      }), ctx);
      if (!valid(ctx)) return;
      validateRows(body);
      if (body.total > 0 && body.offset >= body.total) {
        state.offset = Math.floor((body.total - 1) / state.limit) * state.limit;
        return loadStatement();
      }
      V.amount('mf-opening', V.money(body.summary.opening)); V.amount('mf-closing', V.money(body.summary.closing));
      el('mf-closing-label').textContent = ctx.month === currentMonth() ? 'Saldo atual' : 'Saldo ao fim do mês';
      V.movements('mf-list', body.rows, false, Boolean(state.search || state.direction !== 'all'));
      el('mf-count').textContent = body.total ? (body.offset + 1) + '–' + (body.offset + body.rows.length) + ' de ' + body.total + ' lançamentos' : '0 lançamentos';
      el('mf-prev').disabled = body.offset === 0;
      el('mf-next').disabled = body.offset + body.rows.length >= body.total;
      hidden('mf-pagination', body.total === 0);
      hidden('mf-list-loading', true); hidden('mf-statement-results', false); hidden('mf-statement-balances', false);
      hidden('mf-statement-warning', body.integration_status !== 'yellow'); updated(new Date(body.as_of));
    } catch (error) {
      if (ctx && ignored(error, ctx)) return;
      hidden('mf-list-loading', true); hidden('mf-list-error', false);
      el('mf-list-error-copy').textContent = errorText(error);
    } finally { if (request === controller) request = null; }
  }
  async function load() {
    if (!C.token() || C.isPartner() || !C.canModule('financeiro')) return;
    return state.tab === 'statement' ? loadStatement() : loadSummary();
  }
  function setTab(tab) {
    el('mf-detail').close();
    state.tab = tab === 'finance' ? 'summary' : 'statement';
    if (tab === 'finance-in' || tab === 'finance-out') { state.direction = tab === 'finance-in' ? 'in' : 'out'; state.offset = 0; }
    el('mf-tab-summary').toggleAttribute('aria-current', state.tab === 'summary');
    el('mf-tab-statement').toggleAttribute('aria-current', state.tab === 'statement');
    el(state.tab === 'summary' ? 'mf-tab-summary' : 'mf-tab-statement').setAttribute('aria-current', 'page');
    hidden('mf-statement', state.tab !== 'statement'); hidden('mf-summary', true);
    if (!el('mf-month').value) el('mf-month').value = currentMonth();
    try { period(); } catch { /* A tela de erro é preenchida pelo carregamento. */ }
  }
  function open(tab, direction) {
    if (!C.canModule('financeiro') || C.isPartner()) return;
    state.offset = 0;
    if (tab === 'statement') { state.direction = direction || 'all'; state.search = ''; el('mf-search').value = ''; }
    const hash = tab === 'statement' ? '#financeiro/extrato' : '#financeiro';
    if (location.hash !== hash) history.pushState(null, '', hash);
    C.showTab(tab === 'statement' ? 'finance-statement' : 'finance');
    if (tab !== 'statement') void load();
  }
  function reset() {
    cancel(); state.payload = null; state.masked = false; state.search = ''; state.direction = 'all'; state.offset = 0;
    el('mf-month').value = ''; el('mf-search').value = ''; el('mf-detail').close();
    el('mf-detail-body').replaceChildren(); el('mf-list').replaceChildren(); el('mf-recent').replaceChildren();
    hidden('mf-summary', true); hidden('mf-statement-results', true); V.privacy(false);
  }
  async function showAccounts() {
    if (accountsRequest) accountsRequest.abort();
    const controller = new AbortController(); accountsRequest = controller;
    const body = V.dialog('Contas em aberto');
    body.appendChild(V.node('p', 'Conferindo a posição atual…'));
    let ctx;
    try {
      ctx = context(controller);
      const payload = await fetchData('/api/caixa/financeiro-simples?period=' + ctx.month, ctx);
      if (!valid(ctx) || !el('mf-detail').open) return;
      body.replaceChildren(V.node('p', 'Posição atual, incluindo vencimentos de outros meses.'));
      for (const [key, title] of [['a_pagar', 'A pagar'], ['a_receber', 'A receber']]) {
        const group = payload.agenda[key]; body.appendChild(V.node('h4', title));
        V.lines(body, [['Total em aberto', V.money(group.total)]], true);
        if (!group.itens.length) body.appendChild(V.node('p', 'Nenhuma conta em aberto.'));
        group.itens.forEach(row => {
          V.lines(body, [[row.nome, V.money(row.valor)]], true);
          body.appendChild(V.node('p', row.due_date ? (row.overdue ? 'Vencida · ' : 'Vencimento · ') + window.FarejadorTime.formatDate(row.due_date) : 'Sem vencimento informado'));
        });
      }
    } catch (error) {
      if (ctx && ignored(error, ctx)) return;
      body.replaceChildren(V.node('p', errorText(error)));
    } finally { if (accountsRequest === controller) accountsRequest = null; }
  }
  el('mf-month').addEventListener('change', () => { state.offset = 0; el('mf-detail').close(); void load(); });
  el('mf-tab-summary').addEventListener('click', () => open('summary'));
  el('mf-tab-statement').addEventListener('click', () => open('statement'));
  el('mf-accounts').addEventListener('click', showAccounts);
  el('mf-see-all').addEventListener('click', () => open('statement'));
  ['mf-refresh', 'mf-retry', 'mf-list-retry'].forEach(id => el(id).addEventListener('click', load));
  el('mf-recent-retry').addEventListener('click', loadRecent);
  document.querySelectorAll('[data-mf-direction]').forEach(button => button.addEventListener('click', () => open('statement', button.dataset.mfDirection)));
  document.querySelectorAll('[data-mf-filter]').forEach(button => button.addEventListener('click', () => { state.direction = button.dataset.mfFilter; state.offset = 0; void loadStatement(); }));
  el('mf-search').addEventListener('input', () => {
    if (request) request.abort(); clearTimeout(timer);
    state.search = el('mf-search').value.trim(); state.offset = 0; hidden('mf-search-clear', !el('mf-search').value);
    hidden('mf-statement-results', true); hidden('mf-list-error', true); hidden('mf-list-loading', false);
    timer = setTimeout(loadStatement, 250);
  });
  el('mf-search-clear').addEventListener('click', () => { el('mf-search').value = ''; state.search = ''; state.offset = 0; void loadStatement(); el('mf-search').focus(); });
  el('mf-prev').addEventListener('click', () => { state.offset = Math.max(0, state.offset - state.limit); void loadStatement(); });
  el('mf-next').addEventListener('click', () => { state.offset += state.limit; void loadStatement(); });
  el('mf-privacy').addEventListener('click', () => { state.masked = !state.masked; V.privacy(state.masked); });
  el('mf-result-card').addEventListener('click', () => { if (state.payload) V.resultDetail(state.payload); });
  el('mf-stock').addEventListener('click', () => {
    const stock = state.payload && state.payload.inventory; if (!stock) return;
    const body = V.dialog('Estoque atual pelo custo');
    V.lines(body, [['Custo dos pneus em estoque', V.money(stock.capital)]], true);
    body.appendChild(V.node('p', stock.pneus + ' pneus na posição atual. Esse valor representa produtos, não dinheiro em caixa.'));
    if (stock.sem_custo) body.appendChild(V.node('p', stock.sem_custo + ' pneus ainda estão sem custo informado. O valor é parcial.'));
    if (C.canModule('estoque')) {
      const button = V.node('button', 'Ver estoque', 'mf-primary'); button.type = 'button';
      button.addEventListener('click', () => { el('mf-detail').close(); C.showTab('stock'); if (C.loadStock) void C.loadStock(); }); body.appendChild(button);
    }
  });
  el('mf-commissions').addEventListener('click', () => { if (C.stored(C.keys.role) === 'owner') C.openFinanceCommissions(); });
  ['mf-detail-close', 'mf-detail-done'].forEach(id => el(id).addEventListener('click', () => el('mf-detail').close()));
  el('mf-detail').addEventListener('click', event => { if (event.target === el('mf-detail')) { const box = el('mf-detail').getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) el('mf-detail').close(); } });
  window.addEventListener('hashchange', () => {
    if (!C.token() || C.isPartner() || !C.canModule('financeiro')) return;
    const tabs = { '#financeiro': 'finance', '#financeiro/extrato': 'finance-statement', '#financeiro/entradas': 'finance-in', '#financeiro/saidas': 'finance-out' };
    const tab = tabs[location.hash]; if (!tab) return;
    C.showTab(tab); if (tab === 'finance') void load();
  });
  C.financeMatrix = { load, open, setTab, reset, cancel };
}());
