(function () {
  'use strict';

  const Caixa = window.Caixa;
  const byId = function (id) { return document.getElementById(id); };
  const itemGroups = ['tire', 'service', 'other'];
  const itemLabels = { tire: 'Pneus', service: 'Serviços', other: 'Outros' };
  let range = '30d';
  let collaboratorId = '';
  let request = null;
  let detailPayload = null;

  function initials(name) {
    const words = String(name || 'Colaborador').trim().split(/\s+/).filter(Boolean);
    return (((words[0] && words[0][0]) || 'C')
      + ((words.length > 1 && words[words.length - 1][0]) || (words[0] && words[0][1]) || 'O'))
      .toUpperCase();
  }

  function ruleLabel(row) {
    if (row.commission_itemized) return 'Por tipo de item';
    if (!row.commission_kind || !Number(row.commission_value || 0)) return 'Sem regra';
    if (row.commission_kind === 'percent') {
      return Number(row.commission_value).toLocaleString('pt-BR') + '%';
    }
    return Caixa.currency.format(Number(row.commission_value)) + ' por venda';
  }

  function itemRuleLabel(rule, group) {
    if (!rule || rule.kind === 'none' || !Number(rule.value || 0)) return 'Sem comissão';
    if (rule.kind === 'percent') return Number(rule.value).toLocaleString('pt-BR') + '%';
    return Caixa.currency.format(Number(rule.value)) + (group === 'tire' ? ' por pneu' : ' por item');
  }

  function paymentLabel(value) {
    const clean = String(value || '').toLowerCase();
    if (clean.includes('pix')) return 'Pix';
    if (clean.includes('cart')) return 'Cartão';
    if (clean.includes('dinheiro') || clean.includes('cash')) return 'Dinheiro';
    if (clean.includes('transfer')) return 'Transferência';
    return 'Outros';
  }

  function periodLabel(row) {
    if (!row.payment_period_start || !row.payment_period_end) return '';
    const options = { day: '2-digit', month: 'short', timeZone: 'UTC' };
    const formatter = new Intl.DateTimeFormat('pt-BR', options);
    const start = new Date(String(row.payment_period_start).slice(0, 10) + 'T12:00:00Z');
    const end = new Date(String(row.payment_period_end).slice(0, 10) + 'T12:00:00Z');
    return formatter.format(start).replace('.', '') + ' a ' + formatter.format(end).replace('.', '');
  }

  function setState(state) {
    byId('finance-commission-detail-loading').classList.toggle('hidden', state !== 'loading');
    byId('finance-commission-detail-error').classList.toggle('hidden', state !== 'error');
    byId('finance-commission-detail-content').classList.toggle('hidden', state !== 'ready');
  }

  function setRangeButtons() {
    document.querySelectorAll('[data-commission-detail-range]').forEach(function (button) {
      button.classList.toggle('active', button.dataset.commissionDetailRange === range);
    });
  }

  function renderRuleBreakdown(row) {
    const section = byId('finance-commission-detail-rules');
    section.replaceChildren();
    section.classList.toggle('hidden', !row.commission_itemized);
    if (!row.commission_itemized) return;
    const title = document.createElement('h3');
    title.textContent = 'Regra atual por item';
    section.appendChild(title);
    itemGroups.forEach(function (group) {
      const card = document.createElement('p');
      const label = document.createElement('small');
      const value = document.createElement('strong');
      label.textContent = itemLabels[group];
      value.textContent = itemRuleLabel(row.commission_item_rules && row.commission_item_rules[group], group);
      card.append(label, value); section.appendChild(card);
    });
  }

  function saleRow(row) {
    const article = document.createElement('article');
    const icon = document.createElement('span');
    icon.className = 'finance-commission-sale-icon';
    const adjustment = row.entry_type === 'adjustment';
    icon.textContent = adjustment ? 'A' : paymentLabel(row.payment_method).slice(0, 1);
    const copy = document.createElement('div');
    const title = document.createElement('strong');
    const meta = document.createElement('small');
    title.textContent = row.reference || (adjustment ? 'Ajuste' : 'Venda');
    const date = new Intl.DateTimeFormat('pt-BR', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
      timeZone: 'America/Sao_Paulo',
    }).format(new Date(row.occurred_at));
    meta.textContent = date + (adjustment ? ' · ajuste/reversão' : ' · ' + paymentLabel(row.payment_method));
    copy.append(title, meta);
    const values = document.createElement('div');
    const sale = document.createElement('span');
    const commission = document.createElement('b');
    const appliedRule = document.createElement('small');
    sale.textContent = Caixa.currency.format(Number(row.gross_amount || 0));
    commission.textContent = Caixa.currency.format(Number(row.commission_amount || 0));
    appliedRule.className = 'finance-commission-sale-rule';
    appliedRule.textContent = adjustment ? 'ajuste conciliado'
      : (row.commission_itemized ? 'por tipo de item' : 'regra da venda');
    values.append(sale, commission, appliedRule); article.append(icon, copy, values);
    return article;
  }

  function render(payload) {
    detailPayload = payload;
    const row = payload.collaborator;
    byId('finance-commission-detail-unit').textContent = payload.unit_name || 'Unidade';
    byId('finance-commission-person-avatar').textContent = initials(row.name);
    byId('finance-commission-person-name').textContent = row.name;
    byId('finance-commission-person-role').textContent = row.role || 'Colaborador';
    byId('finance-commission-person-status').textContent = row.active ? 'Ativo' : 'Inativo';
    byId('finance-commission-detail-total').textContent = Caixa.currency.format(Number(row.commission_amount || 0));
    byId('finance-commission-detail-sales').textContent = Number(row.sales_count || 0);
    byId('finance-commission-detail-gross').textContent = Caixa.currency.format(Number(row.gross_sales || 0));
    byId('finance-commission-detail-rule').textContent = ruleLabel(row);
    renderRuleBreakdown(row);
    const list = byId('finance-commission-detail-list');
    const sales = Array.isArray(payload.sales) ? payload.sales : [];
    list.replaceChildren();
    if (!sales.length) {
      const empty = document.createElement('p');
      empty.className = 'finance-commission-empty';
      empty.textContent = 'Nenhuma venda ou ajuste de comissão neste período.';
      list.appendChild(empty);
    } else sales.forEach(function (sale) { list.appendChild(saleRow(sale)); });
    renderPayment(row); setState('ready');
  }

  function renderPayment(row) {
    const pay = byId('finance-commission-pay');
    pay.dataset.status = row.status; pay.disabled = row.status !== 'payable';
    if (row.status === 'paid') pay.textContent = 'Comissão paga';
    else if (row.status !== 'payable') pay.textContent = 'Em aberto · aguardando fechamento';
    else {
      const total = Number(row.payment_total || row.commission_amount || 0);
      const includesPayroll = Math.abs(total - Number(row.commission_amount || 0)) > 0.009;
      const label = periodLabel(row);
      pay.textContent = (includesPayroll ? 'Pagar remuneração' : 'Pagar comissão')
        + (label ? ' · ' + label : '') + ' · ' + Caixa.currency.format(total);
    }
    byId('finance-commission-payment-note').textContent = row.status === 'open'
      ? (row.settlement_frequency === 'weekly'
        ? 'A semana fecha no sábado e fica disponível para pagamento no domingo.'
        : 'O mês fecha no último dia e fica disponível no primeiro dia do mês seguinte.')
      : 'O pagamento ficará registrado como saída no Financeiro.';
    byId('finance-commission-payment-error').textContent = '';
  }

  async function load() {
    if (!collaboratorId && window.location.hash.startsWith('#financeiro/comissoes/')) {
      collaboratorId = decodeURIComponent(window.location.hash.slice('#financeiro/comissoes/'.length));
    }
    if (!collaboratorId) return;
    if (request) request.abort();
    const controller = new AbortController(); request = controller;
    setState('loading'); setRangeButtons();
    try {
      const base = Caixa.operationPath('financeiro-comissoes', '/api/caixa/financeiro-comissoes');
      const response = await Caixa.authenticatedFetch(
        base + '/' + encodeURIComponent(collaboratorId) + '?range=' + encodeURIComponent(range),
        { signal: controller.signal },
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

  async function pay() {
    const row = detailPayload && detailPayload.collaborator;
    if (!row || row.status !== 'payable' || !row.payment_target_id) return;
    const button = byId('finance-commission-pay');
    const total = Number(row.payment_total || row.commission_amount || 0);
    if (!window.confirm('Confirmar o pagamento de ' + Caixa.currency.format(total) + '?')) return;
    button.disabled = true; button.textContent = 'Registrando pagamento…';
    try {
      const base = Caixa.operationPath('financeiro-comissoes', '/api/caixa/financeiro-comissoes');
      const response = await Caixa.authenticatedFetch(base + '/' + encodeURIComponent(row.id) + '/pagar', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payment_target_id: row.payment_target_id,
          idempotency_key: 'operation-commission-' + row.payment_target_id }),
      });
      const payload = await Caixa.json(response);
      if (!response.ok) throw new Error(payload.error || 'request_failed');
      Caixa.showToast('Pagamento registrado no Financeiro.'); await load();
    } catch (_failure) {
      byId('finance-commission-payment-error').textContent =
        'Não foi possível registrar o pagamento. Atualize os dados e tente novamente.';
      button.disabled = false; button.textContent = 'Tentar pagar novamente';
    }
  }

  function open(id) {
    collaboratorId = id; window.location.hash = '#financeiro/comissoes/' + encodeURIComponent(id);
    Caixa.showTab('finance-commission-detail');
  }

  document.querySelectorAll('[data-commission-detail-range]').forEach(function (button) {
    button.addEventListener('click', function () { range = button.dataset.commissionDetailRange; void load(); });
  });
  byId('finance-commission-detail-back').addEventListener('click', Caixa.openFinanceCommissions);
  byId('finance-commission-detail-retry').addEventListener('click', load);
  byId('finance-commission-pay').addEventListener('click', pay);
  Object.assign(Caixa, { openFinanceCommissionDetail: open, loadFinanceCommissionDetail: load });
}());
