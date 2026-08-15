(function () {
  'use strict';

  const Caixa = window.Caixa;
  const byId = function (id) { return document.getElementById(id); };
  let range = '30d';
  let listRequest = null;

  function initials(name) {
    const words = String(name || 'Colaborador').trim().split(/\s+/).filter(Boolean);
    return ((words[0] && words[0][0]) || 'C')
      + ((words.length > 1 && words[words.length - 1][0]) || (words[0] && words[0][1]) || 'O');
  }

  function count(value, singular, plural) {
    const number = Number(value || 0);
    return number + ' ' + (number === 1 ? singular : plural);
  }

  function ruleLabel(row) {
    if (row.commission_itemized) return 'Por tipo de item';
    if (!row.commission_kind || !Number(row.commission_value || 0)) return 'Sem regra';
    if (row.commission_kind === 'percent') return Number(row.commission_value).toLocaleString('pt-BR') + '%';
    return Caixa.currency.format(Number(row.commission_value)) + ' por venda';
  }

  function setRangeButtons(selector, value) {
    document.querySelectorAll(selector).forEach(function (button) {
      button.classList.toggle('active', button.dataset.commissionRange === value
        || button.dataset.commissionDetailRange === value);
    });
  }

  function setListState(state) {
    byId('finance-commissions-loading').classList.toggle('hidden', state !== 'loading');
    byId('finance-commissions-error').classList.toggle('hidden', state !== 'error');
    byId('finance-commissions-content').classList.toggle('hidden', state !== 'ready');
  }

  function statusButton(row) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'finance-commission-row-action finance-commission-row-action--' + row.status;
    button.textContent = row.status === 'paid' ? 'Pago' : (row.status === 'payable' ? 'Pagar' : 'Em aberto');
    button.disabled = row.status === 'paid';
    button.addEventListener('click', function (event) {
      event.stopPropagation();
      openDetail(row.id);
    });
    return button;
  }

  function renderCollaborator(row) {
    const article = document.createElement('article');
    article.tabIndex = 0;
    article.setAttribute('role', 'button');
    const avatar = document.createElement('span');
    avatar.className = 'finance-commission-avatar';
    avatar.textContent = initials(row.name).toUpperCase();
    const identity = document.createElement('div');
    const name = document.createElement('strong');
    const meta = document.createElement('small');
    name.textContent = row.name;
    meta.textContent = count(row.sales_count, 'venda', 'vendas') + ' · ' + ruleLabel(row);
    identity.append(name, meta);
    const amount = document.createElement('b');
    amount.textContent = Caixa.currency.format(Number(row.commission_amount || 0));
    article.append(avatar, identity, amount, statusButton(row));
    const open = function () { openDetail(row.id); };
    article.addEventListener('click', open);
    article.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
    });
    return article;
  }

  function renderList(payload) {
    const rows = Array.isArray(payload.collaborators) ? payload.collaborators : [];
    byId('finance-commissions-unit').textContent = payload.unit_name || 'Unidade';
    byId('finance-commissions-total').textContent = Caixa.currency.format(Number(payload.total_commission || 0));
    byId('finance-commissions-people').textContent = count(rows.length, 'colaborador', 'colaboradores');
    byId('finance-commissions-sales').textContent = Number(payload.total_sales || 0);
    byId('finance-commissions-average').textContent = Caixa.currency.format(Number(payload.average_commission || 0));
    const list = byId('finance-commissions-list');
    list.replaceChildren();
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'finance-commission-empty';
      empty.textContent = 'Nenhuma comissão calculada neste período.';
      list.appendChild(empty);
    } else rows.forEach(function (row) { list.appendChild(renderCollaborator(row)); });
    setListState('ready');
  }

  async function loadList() {
    if (!Caixa.token() || !Caixa.canModule('financeiro')) return;
    if (listRequest) listRequest.abort();
    const controller = new AbortController(); listRequest = controller;
    setListState('loading'); setRangeButtons('[data-commission-range]', range);
    try {
      const base = Caixa.operationPath('financeiro-comissoes', '/api/caixa/financeiro-comissoes');
      const response = await Caixa.authenticatedFetch(
        base + '?range=' + encodeURIComponent(range), { signal: controller.signal },
      );
      const payload = await Caixa.json(response);
      if (!response.ok) throw new Error(payload.error || 'request_failed');
      renderList(payload);
    } catch (failure) {
      if (failure instanceof DOMException && failure.name === 'AbortError') return;
      if (failure instanceof Error && failure.message === 'invalid_session') return;
      setListState('error');
    } finally { if (listRequest === controller) listRequest = null; }
  }

  function openList() {
    range = byId('finance-period-input').value || range;
    window.location.hash = '#financeiro/comissoes';
    Caixa.showTab('finance-commissions');
  }

  function openDetail(id) {
    if (Caixa.openFinanceCommissionDetail) Caixa.openFinanceCommissionDetail(id);
  }

  document.querySelectorAll('[data-commission-range]').forEach(function (button) {
    button.addEventListener('click', function () { range = button.dataset.commissionRange; void loadList(); });
  });
  byId('finance-commissions-back').addEventListener('click', function () {
    window.location.hash = '#financeiro'; Caixa.showTab('finance'); void Caixa.loadFinance();
  });
  byId('finance-commissions-retry').addEventListener('click', loadList);
  byId('finance-commissions-history').addEventListener('click', function () {
    if (Caixa.openFinanceOutputs) Caixa.openFinanceOutputs();
  });

  Object.assign(Caixa, {
    openFinanceCommissions: openList,
    loadFinanceCommissions: loadList,
  });
}());
