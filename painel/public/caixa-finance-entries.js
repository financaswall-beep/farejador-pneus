(function () {
  'use strict';

  const Caixa = window.Caixa;
  const byId = function (id) { return document.getElementById(id); };
  const panel = byId('finance-entries-panel');
  const range = byId('finance-entries-range');
  const loading = byId('finance-entries-loading');
  const error = byId('finance-entries-error');
  const empty = byId('finance-entries-empty');
  const content = byId('finance-entries-content');
  const list = byId('finance-entries-list');
  const methods = byId('finance-entries-methods');
  const modes = {
    in: {
      title: 'Entradas', summary: 'Entrou no período', singular: 'entrada', plural: 'entradas',
      resource: 'financeiro-entradas', matrixPath: '/api/caixa/financeiro-entradas',
      hash: '#financeiro/entradas', tab: 'finance-in',
      empty: 'Nenhuma entrada neste período',
      hint: 'Quando uma venda ou recebimento for confirmado, aparecerá aqui.',
    },
    out: {
      title: 'Saídas', summary: 'Saiu no período', singular: 'saída', plural: 'saídas',
      resource: 'financeiro-saidas', matrixPath: '/api/caixa/financeiro-saidas',
      hash: '#financeiro/saidas', tab: 'finance-out',
      empty: 'Nenhuma saída neste período',
      hint: 'Quando uma compra, despesa ou conta for paga, aparecerá aqui.',
    },
  };
  let direction = 'in';
  let request = null;

  const dateLabel = new Intl.DateTimeFormat('pt-BR', {
    weekday: 'long', day: '2-digit', month: 'short', timeZone: 'America/Sao_Paulo',
  });
  const timeLabel = new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
  });

  function currentMode() { return modes[direction]; }

  function setDirection(value) {
    direction = value === 'out' ? 'out' : 'in';
    const mode = currentMode();
    panel.classList.toggle('is-output', direction === 'out');
    byId('finance-entries-title').textContent = mode.title;
    byId('finance-entries-summary-label').textContent = mode.summary;
    byId('finance-entries-error-copy').textContent = 'Não foi possível carregar as ' + mode.plural + '.';
    byId('finance-entries-empty-copy').textContent = mode.empty;
    byId('finance-entries-empty-hint').textContent = mode.hint;
    byId('finance-entries-summary-path').setAttribute(
      'd', direction === 'out' ? 'm5 7 11 11m0-7v7H9' : 'M5 17 16 6m-7 0h7v7',
    );
  }

  function setState(name) {
    loading.classList.toggle('hidden', name !== 'loading');
    error.classList.toggle('hidden', name !== 'error');
    empty.classList.toggle('hidden', name !== 'empty');
    content.classList.toggle('hidden', name !== 'ready');
  }

  function paymentLabel(value) {
    const clean = String(value || '').trim().toLowerCase();
    if (clean.includes('pix')) return 'Pix';
    if (clean.includes('cart')) return 'Cartão';
    if (clean.includes('dinheiro') || clean.includes('cash')) return 'Dinheiro';
    if (clean.includes('boleto')) return 'Boleto';
    if (clean.includes('transfer')) return 'Transferência';
    return 'Outros';
  }

  function icon(kind) {
    if (kind === 'sale') return Caixa.createSvg([
      { d: 'M3 4h2l2.4 10.2a2 2 0 0 0 2 1.6h7.8a2 2 0 0 0 2-1.6L21 8H6' },
      { tag: 'circle', cx: '9', cy: '20', r: '1' },
      { tag: 'circle', cx: '18', cy: '20', r: '1' },
    ]);
    if (kind === 'purchase') return Caixa.createSvg([
      { d: 'm4 7 8-4 8 4-8 4zM4 7v10l8 4 8-4V7M12 11v10' },
    ]);
    if (kind === 'payable') return Caixa.createSvg([
      { d: 'M5 4h14v17H5zM8 2v4m8-4v4M5 9h14M8 13h5' },
    ]);
    return Caixa.createSvg([{ d: 'M4 7h16v11H4zM7 12h10M8 7a4 4 0 0 0 8 0' }]);
  }

  function dayTitle(value) {
    const parts = value.split('-').map(Number);
    const day = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], 12));
    const localToday = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'America/Sao_Paulo',
    }).format(new Date());
    if (value === localToday) return 'Hoje';
    const todayParts = localToday.split('-').map(Number);
    const yesterday = new Date(Date.UTC(todayParts[0], todayParts[1] - 1, todayParts[2] - 1));
    if (value === yesterday.toISOString().slice(0, 10)) return 'Ontem';
    const formatted = dateLabel.format(day);
    return formatted.charAt(0).toUpperCase() + formatted.slice(1);
  }

  function makeEntry(row) {
    const article = document.createElement('article');
    article.className = 'finance-entry-card';
    const visual = document.createElement('span');
    visual.className = 'finance-entry-card-icon';
    visual.appendChild(icon(row.kind));
    const copy = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = row.title || (direction === 'out' ? 'Saída' : 'Entrada');
    const subtitle = document.createElement('span');
    subtitle.textContent = row.subtitle || row.origin || 'Movimentação financeira';
    const meta = document.createElement('small');
    const time = row.occurred_at ? timeLabel.format(new Date(row.occurred_at)) : '';
    meta.textContent = [paymentLabel(row.payment_method), time].filter(Boolean).join(' · ');
    copy.append(title, subtitle, meta);
    const amount = document.createElement('b');
    amount.textContent = Caixa.currency.format(Number(row.amount || 0));
    article.append(visual, copy, amount);
    return article;
  }

  function renderMethods(rows) {
    const totals = new Map();
    rows.forEach(function (row) {
      const label = paymentLabel(row.payment_method);
      totals.set(label, (totals.get(label) || 0) + Number(row.amount || 0));
    });
    methods.replaceChildren();
    Array.from(totals.entries()).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 4)
      .forEach(function (entry) {
        const item = document.createElement('div');
        const label = document.createElement('small');
        const value = document.createElement('strong');
        label.textContent = entry[0]; value.textContent = Caixa.currency.format(entry[1]);
        item.append(label, value); methods.appendChild(item);
      });
    methods.classList.toggle('hidden', totals.size === 0);
  }

  function render(payload) {
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    byId('finance-entries-total').textContent = Caixa.currency.format(Number(payload.total || 0));
    const count = Number(payload.count || 0);
    byId('finance-entries-count').textContent = count + (count === 1 ? ' movimentação' : ' movimentações');
    byId('finance-entries-visible').textContent = count > rows.length
      ? 'Mostrando ' + rows.length + ' de ' + count : count + (count === 1 ? ' registro' : ' registros');
    if (!rows.length) { setState('empty'); return; }
    renderMethods(rows);
    list.replaceChildren();
    const groups = new Map();
    rows.forEach(function (row) {
      if (!groups.has(row.entry_date)) groups.set(row.entry_date, []);
      groups.get(row.entry_date).push(row);
    });
    groups.forEach(function (dayRows, day) {
      const section = document.createElement('section');
      const header = document.createElement('header');
      const title = document.createElement('h4');
      const total = document.createElement('strong');
      title.textContent = dayTitle(day);
      total.textContent = Caixa.currency.format(dayRows.reduce(function (sum, row) {
        return sum + Number(row.amount || 0);
      }, 0));
      header.append(title, total); section.appendChild(header);
      dayRows.forEach(function (row) { section.appendChild(makeEntry(row)); });
      list.appendChild(section);
    });
    setState('ready');
  }

  async function loadFinanceEntries() {
    if (!Caixa.token() || !Caixa.canModule('financeiro')) return;
    if (request) request.abort();
    const controller = new AbortController(); request = controller; setState('loading');
    const mode = currentMode();
    try {
      const path = Caixa.operationPath(mode.resource, mode.matrixPath);
      const response = await Caixa.authenticatedFetch(
        path + '?range=' + encodeURIComponent(range.value), { signal: controller.signal },
      );
      const payload = await Caixa.json(response);
      if (!response.ok) throw new Error(payload.error || 'request_failed');
      render(payload);
    } catch (failure) {
      if (failure instanceof DOMException && failure.name === 'AbortError') return;
      if (failure instanceof Error && failure.message === 'invalid_session') return;
      setState('error');
    } finally { if (request === controller) request = null; }
  }

  function openFinanceMovement(value) {
    setDirection(value);
    range.value = byId('finance-period-input').value || '30d';
    const mode = currentMode();
    window.location.hash = mode.hash;
    Caixa.showTab(mode.tab);
  }

  function closeFinanceEntries() {
    byId('finance-period-input').value = range.value;
    window.location.hash = '#financeiro';
    Caixa.showTab('finance');
    void Caixa.loadFinance();
  }

  range.addEventListener('change', loadFinanceEntries);
  byId('finance-entries-back').addEventListener('click', closeFinanceEntries);
  byId('finance-entries-retry').addEventListener('click', loadFinanceEntries);
  byId('finance-entries-full').addEventListener('click', function () { Caixa.openFullFinance(); });
  window.addEventListener('hashchange', function () {
    if (!Caixa.token() || !Caixa.canModule('financeiro')) return;
    const target = Object.keys(modes).find(function (key) { return modes[key].hash === window.location.hash; });
    if (target && panel.classList.contains('hidden')) {
      setDirection(target); Caixa.showTab(currentMode().tab);
    }
  });
  Object.assign(Caixa, {
    openFinanceEntries: function () { openFinanceMovement('in'); },
    openFinanceOutputs: function () { openFinanceMovement('out'); },
    setFinanceMovementMode: setDirection,
    loadFinanceEntries: loadFinanceEntries,
  });
}());
