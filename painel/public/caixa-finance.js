(function () {
  'use strict';

  const Caixa = window.Caixa;
  const byId = function (id) { return document.getElementById(id); };
  const periodInput = byId('finance-period-input');
  const periodLabel = byId('finance-period-label');
  const loading = byId('finance-loading');
  const error = byId('finance-error');
  const errorCopy = byId('finance-error-copy');
  const content = byId('finance-content');
  let request = null;

  const rangeLabels = { today: 'Hoje', '7d': '7 dias', '15d': '15 dias', '30d': '1 mês' };

  function selectedRange() {
    return Object.prototype.hasOwnProperty.call(rangeLabels, periodInput.value)
      ? periodInput.value : '30d';
  }

  function statusText(range, positive) {
    if (range === 'today') return positive ? 'Hoje está positivo' : 'Hoje está negativo';
    if (range === '7d') return positive ? 'Últimos 7 dias positivos' : 'Últimos 7 dias negativos';
    if (range === '15d') return positive ? 'Últimos 15 dias positivos' : 'Últimos 15 dias negativos';
    return positive ? 'Último mês positivo' : 'Último mês negativo';
  }

  function setState(name, message) {
    loading.classList.toggle('hidden', name !== 'loading');
    error.classList.toggle('hidden', name !== 'error');
    content.classList.toggle('hidden', name !== 'ready');
    if (message) errorCopy.textContent = message;
  }

  function countText(value, singular, plural) {
    const count = Number(value || 0);
    return count + ' ' + (count === 1 ? singular : plural);
  }

  function render(payload) {
    const net = Number(payload.cash_net || 0);
    const positive = net >= 0;
    const hero = byId('finance-hero');
    byId('session-view').classList.toggle('finance-negative', !positive);
    hero.classList.toggle('finance-hero--positive', positive);
    hero.classList.toggle('finance-hero--negative', !positive);
    byId('finance-result-label').textContent = positive ? 'Sobrou' : 'Prejuízo';
    byId('finance-net').textContent = Caixa.currency.format(net);
    byId('finance-status').querySelector('b').textContent = statusText(
      payload.range || selectedRange(), positive,
    );
    byId('finance-in').textContent = Caixa.currency.format(Number(payload.cash_in || 0));
    byId('finance-out').textContent = Caixa.currency.format(Number(payload.cash_out || 0));

    const receivable = Number(payload.receivable_total || 0);
    const receivableCount = Number(payload.receivable_count || 0);
    byId('finance-receivable').textContent = receivableCount
      ? Caixa.currency.format(receivable) + ' para receber'
      : 'Nenhum valor para receber';
    const dueCount = Number(payload.due_today_count || 0);
    const dueTotal = Number(payload.due_today_total || 0);
    byId('finance-due').textContent = dueCount
      ? countText(dueCount, 'conta vence hoje', 'contas vencem hoje')
        + (dueTotal > 0 ? ' · ' + Caixa.currency.format(dueTotal) : '')
      : 'Nenhuma conta vence hoje';

    byId('finance-commission-total').textContent = Caixa.currency.format(
      Number(payload.commission_total || 0),
    );
    const staff = Number(payload.commission_collaborators || 0);
    byId('finance-commission-count').textContent = staff
      ? countText(staff, 'colaborador', 'colaboradores')
      : 'Nenhum colaborador com comissão';
    setState('ready');
  }

  async function loadFinance() {
    if (!Caixa.token() || !Caixa.canModule('financeiro')) return;
    if (request) request.abort();
    const controller = new AbortController();
    request = controller;
    setState('loading');
    const range = selectedRange();
    periodInput.value = range;
    periodLabel.textContent = rangeLabels[range];
    try {
      const path = Caixa.operationPath('financeiro-simples', '/api/caixa/financeiro-simples');
      const response = await Caixa.authenticatedFetch(
        path + '?range=' + encodeURIComponent(range), { signal: controller.signal },
      );
      const payload = await Caixa.json(response);
      if (!response.ok) throw new Error(payload.error || 'request_failed');
      render(payload);
    } catch (failure) {
      if (failure instanceof DOMException && failure.name === 'AbortError') return;
      if (failure instanceof Error && failure.message === 'invalid_session') return;
      const unavailable = failure instanceof Error && failure.message.includes('central_ledger');
      setState('error', unavailable
        ? 'O livro financeiro central está temporariamente indisponível.'
        : 'Confira sua conexão e tente novamente.');
    } finally {
      if (request === controller) request = null;
    }
  }

  function openFullFinance() {
    if (Caixa.isPartner()) {
      window.location.href = '/parceiro/' + encodeURIComponent(Caixa.slug()) + '/';
      return;
    }
    window.location.href = '/login?modo=painel';
  }

  periodInput.value = '30d';
  periodLabel.textContent = rangeLabels['30d'];
  periodInput.addEventListener('change', function () { void loadFinance(); });
  byId('finance-retry').addEventListener('click', function () { void loadFinance(); });
  byId('finance-full').addEventListener('click', openFullFinance);
  document.querySelectorAll('[data-finance-detail]').forEach(function (button) {
    button.addEventListener('click', function () {
      if (button.dataset.financeDetail === 'in' && Caixa.openFinanceEntries) {
        Caixa.openFinanceEntries();
        return;
      }
      if (button.dataset.financeDetail === 'out' && Caixa.openFinanceOutputs) {
        Caixa.openFinanceOutputs();
        return;
      }
      openFullFinance();
    });
  });

  Object.assign(Caixa, { loadFinance: loadFinance, openFullFinance: openFullFinance });
}());
