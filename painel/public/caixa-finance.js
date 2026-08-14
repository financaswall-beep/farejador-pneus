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

  function monthValue(date) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit',
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(function (part) { return [part.type, part.value]; }));
    return values.year + '-' + values.month;
  }

  function currentPeriod() { return monthValue(new Date()); }

  function periodText(value) {
    if (value === currentPeriod()) return 'Este mês';
    const parts = value.split('-').map(Number);
    if (parts.length !== 2 || !parts[0] || !parts[1]) return 'Este mês';
    const text = new Intl.DateTimeFormat('pt-BR', {
      month: 'long', year: 'numeric', timeZone: 'America/Sao_Paulo',
    }).format(new Date(Date.UTC(parts[0], parts[1] - 1, 2)));
    return text.charAt(0).toUpperCase() + text.slice(1);
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
    hero.classList.toggle('finance-hero--positive', positive);
    hero.classList.toggle('finance-hero--negative', !positive);
    byId('finance-result-label').textContent = positive ? 'Sobrou' : 'Prejuízo';
    byId('finance-net').textContent = Caixa.currency.format(net);
    byId('finance-status').querySelector('b').textContent = positive
      ? 'Este mês está positivo' : 'Este mês fechou negativo';
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
    const period = periodInput.value || currentPeriod();
    periodInput.value = period;
    periodLabel.textContent = periodText(period);
    try {
      const path = Caixa.operationPath('financeiro-simples', '/api/caixa/financeiro-simples');
      const response = await Caixa.authenticatedFetch(
        path + '?period=' + encodeURIComponent(period), { signal: controller.signal },
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

  const now = currentPeriod();
  const minimum = new Date();
  minimum.setFullYear(minimum.getFullYear() - 3);
  periodInput.max = now;
  periodInput.min = monthValue(minimum);
  periodInput.value = now;
  periodLabel.textContent = 'Este mês';
  periodInput.addEventListener('change', function () { void loadFinance(); });
  byId('finance-retry').addEventListener('click', function () { void loadFinance(); });
  byId('finance-full').addEventListener('click', openFullFinance);
  document.querySelectorAll('[data-finance-detail]').forEach(function (button) {
    button.addEventListener('click', openFullFinance);
  });

  Object.assign(Caixa, { loadFinance: loadFinance });
}());
