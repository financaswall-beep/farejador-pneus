(function () {
  'use strict';

  const Caixa = window.Caixa;
  const byId = function (id) { return document.getElementById(id); };
  const listPanel = byId('finance-commissions-panel');
  const detailPanel = byId('finance-commission-detail-panel');
  let range = '30d';
  let collaboratorId = '';
  let listRequest = null;
  let detailRequest = null;
  let detailPayload = null;

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
    if (!row.commission_kind || !Number(row.commission_value || 0)) return 'Sem regra';
    if (row.commission_kind === 'percent') return Number(row.commission_value).toLocaleString('pt-BR') + '%';
    return Caixa.currency.format(Number(row.commission_value)) + ' por venda';
  }

  function paymentLabel(value) {
    const clean = String(value || '').toLowerCase();
    if (clean.includes('pix')) return 'Pix';
    if (clean.includes('cart')) return 'Cartão';
    if (clean.includes('dinheiro') || clean.includes('cash')) return 'Dinheiro';
    if (clean.includes('transfer')) return 'Transferência';
    return 'Outros';
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

  function setDetailState(state) {
    byId('finance-commission-detail-loading').classList.toggle('hidden', state !== 'loading');
    byId('finance-commission-detail-error').classList.toggle('hidden', state !== 'error');
    byId('finance-commission-detail-content').classList.toggle('hidden', state !== 'ready');
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

  function saleRow(row) {
    const article = document.createElement('article');
    const icon = document.createElement('span');
    icon.className = 'finance-commission-sale-icon';
    icon.textContent = paymentLabel(row.payment_method).slice(0, 1);
    const copy = document.createElement('div');
    const title = document.createElement('strong');
    const meta = document.createElement('small');
    title.textContent = row.reference || 'Venda';
    const date = new Intl.DateTimeFormat('pt-BR', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
      timeZone: 'America/Sao_Paulo',
    }).format(new Date(row.occurred_at));
    meta.textContent = date + ' · ' + paymentLabel(row.payment_method);
    copy.append(title, meta);
    const values = document.createElement('div');
    const sale = document.createElement('span');
    const commission = document.createElement('b');
    sale.textContent = Caixa.currency.format(Number(row.gross_amount || 0));
    commission.textContent = Caixa.currency.format(Number(row.commission_amount || 0));
    values.append(sale, commission);
    article.append(icon, copy, values);
    return article;
  }

  function renderDetail(payload) {
    detailPayload = payload;
    const row = payload.collaborator;
    byId('finance-commission-detail-unit').textContent = payload.unit_name || 'Unidade';
    byId('finance-commission-person-avatar').textContent = initials(row.name).toUpperCase();
    byId('finance-commission-person-name').textContent = row.name;
    byId('finance-commission-person-role').textContent = row.role || 'Colaborador';
    byId('finance-commission-person-status').textContent = row.active ? 'Ativo' : 'Inativo';
    byId('finance-commission-detail-total').textContent = Caixa.currency.format(Number(row.commission_amount || 0));
    byId('finance-commission-detail-sales').textContent = Number(row.sales_count || 0);
    byId('finance-commission-detail-gross').textContent = Caixa.currency.format(Number(row.gross_sales || 0));
    byId('finance-commission-detail-rule').textContent = ruleLabel(row);
    const list = byId('finance-commission-detail-list');
    list.replaceChildren();
    const sales = Array.isArray(payload.sales) ? payload.sales : [];
    if (!sales.length) {
      const empty = document.createElement('p');
      empty.className = 'finance-commission-empty';
      empty.textContent = 'Nenhuma venda com comissão neste período.';
      list.appendChild(empty);
    } else sales.forEach(function (sale) { list.appendChild(saleRow(sale)); });
    const pay = byId('finance-commission-pay');
    pay.dataset.status = row.status;
    pay.disabled = row.status !== 'payable';
    if (row.status === 'paid') pay.textContent = 'Comissão paga';
    else if (row.status !== 'payable') pay.textContent = 'Em aberto · aguardando fechamento';
    else {
      const total = Number(row.payment_total || row.commission_amount || 0);
      const includesPayroll = Math.abs(total - Number(row.commission_amount || 0)) > 0.009;
      pay.textContent = (includesPayroll ? 'Pagar remuneração · ' : 'Pagar comissão · ')
        + Caixa.currency.format(total);
    }
    byId('finance-commission-payment-note').textContent = row.status === 'open'
      ? 'O valor será liberado depois do fechamento da remuneração.'
      : 'O pagamento ficará registrado como saída no Financeiro.';
    byId('finance-commission-payment-error').textContent = '';
    setDetailState('ready');
  }

  async function loadDetail() {
    if (!collaboratorId && window.location.hash.startsWith('#financeiro/comissoes/')) {
      collaboratorId = decodeURIComponent(window.location.hash.slice('#financeiro/comissoes/'.length));
    }
    if (!collaboratorId) return;
    if (detailRequest) detailRequest.abort();
    const controller = new AbortController(); detailRequest = controller;
    setDetailState('loading'); setRangeButtons('[data-commission-detail-range]', range);
    try {
      const base = Caixa.operationPath('financeiro-comissoes', '/api/caixa/financeiro-comissoes');
      const response = await Caixa.authenticatedFetch(
        base + '/' + encodeURIComponent(collaboratorId) + '?range=' + encodeURIComponent(range),
        { signal: controller.signal },
      );
      const payload = await Caixa.json(response);
      if (!response.ok) throw new Error(payload.error || 'request_failed');
      renderDetail(payload);
    } catch (failure) {
      if (failure instanceof DOMException && failure.name === 'AbortError') return;
      if (failure instanceof Error && failure.message === 'invalid_session') return;
      setDetailState('error');
    } finally { if (detailRequest === controller) detailRequest = null; }
  }

  function openList() {
    range = byId('finance-period-input').value || range;
    window.location.hash = '#financeiro/comissoes';
    Caixa.showTab('finance-commissions');
  }

  function openDetail(id) {
    collaboratorId = id;
    window.location.hash = '#financeiro/comissoes/' + encodeURIComponent(id);
    Caixa.showTab('finance-commission-detail');
  }

  async function pay() {
    const row = detailPayload && detailPayload.collaborator;
    if (!row || row.status !== 'payable' || !row.payment_target_id) return;
    const button = byId('finance-commission-pay');
    const total = Number(row.payment_total || row.commission_amount || 0);
    if (!window.confirm('Confirmar o pagamento de ' + Caixa.currency.format(total) + '?')) return;
    button.disabled = true; button.textContent = 'Registrando pagamento…';
    try {
      const base = Caixa.operationPath('financeiro-comissoes', '/api/caixa/financeiro-comissoes');
      const response = await Caixa.authenticatedFetch(
        base + '/' + encodeURIComponent(row.id) + '/pagar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            payment_target_id: row.payment_target_id,
            idempotency_key: 'operation-commission-' + row.payment_target_id,
          }),
        },
      );
      const payload = await Caixa.json(response);
      if (!response.ok) throw new Error(payload.error || 'request_failed');
      Caixa.showToast('Pagamento registrado no Financeiro.');
      await loadDetail();
    } catch (failure) {
      byId('finance-commission-payment-error').textContent =
        'Não foi possível registrar o pagamento. Atualize os dados e tente novamente.';
      button.disabled = false;
      button.textContent = 'Tentar pagar novamente';
    }
  }

  document.querySelectorAll('[data-commission-range]').forEach(function (button) {
    button.addEventListener('click', function () { range = button.dataset.commissionRange; void loadList(); });
  });
  document.querySelectorAll('[data-commission-detail-range]').forEach(function (button) {
    button.addEventListener('click', function () { range = button.dataset.commissionDetailRange; void loadDetail(); });
  });
  byId('finance-commissions-back').addEventListener('click', function () {
    window.location.hash = '#financeiro'; Caixa.showTab('finance'); void Caixa.loadFinance();
  });
  byId('finance-commission-detail-back').addEventListener('click', openList);
  byId('finance-commissions-retry').addEventListener('click', loadList);
  byId('finance-commission-detail-retry').addEventListener('click', loadDetail);
  byId('finance-commission-pay').addEventListener('click', pay);
  byId('finance-commissions-history').addEventListener('click', function () {
    if (Caixa.openFinanceOutputs) Caixa.openFinanceOutputs();
  });

  Object.assign(Caixa, {
    openFinanceCommissions: openList,
    openFinanceCommissionDetail: openDetail,
    loadFinanceCommissions: loadList,
    loadFinanceCommissionDetail: loadDetail,
  });
}());
