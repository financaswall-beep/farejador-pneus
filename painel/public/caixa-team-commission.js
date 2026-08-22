(function () {
  'use strict';

  const Caixa = window.Caixa;
  const state = Caixa.teamState;
  let payload = null;

  const basisLabels = {
    revenue: 'Valor final da venda', margin: 'Margem da venda', sale: 'Por venda',
    delivery: 'Por entrega concluída', trip: 'Por rota concluída',
  };
  const itemGroups = ['tire', 'service', 'other'];
  const itemLabels = { tire: 'Pneus', service: 'Serviços', other: 'Outros' };

  function formatDate(value) {
    const parts = String(value || '').slice(0, 10).split('-');
    return parts.length === 3 ? parts.reverse().join('/') : String(value || '');
  }

  function historyLabel(item) {
    if (!item.active) return 'Sem comissão';
    if (item.itemized) {
      return itemGroups.map(function (group) {
        const rule = (item.item_rules && item.item_rules[group]) || { kind: 'none', value: 0 };
        if (rule.kind === 'none') return itemLabels[group] + ': sem comissão';
        return itemLabels[group] + ': ' + (rule.kind === 'percent'
          ? Number(rule.value || 0).toLocaleString('pt-BR') + '%'
          : Caixa.currency.format(Number(rule.value || 0)) + ' por pneu');
      }).join(' · ');
    }
    return item.kind === 'percent'
      ? Number(item.value || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%'
      : Caixa.currency.format(Number(item.value || 0)) + ' por ' + String(basisLabels[item.basis] || item.basis).toLowerCase();
  }

  function renderHistory(items) {
    const list = document.getElementById('team-commission-history'); list.replaceChildren();
    if (!items || !items.length) {
      const empty = document.createElement('p'); empty.className = 'team-empty';
      empty.textContent = 'Nenhuma alteração anterior registrada.'; list.appendChild(empty); return;
    }
    items.forEach(function (item) {
      const row = document.createElement('article');
      const title = document.createElement('strong'); title.textContent = historyLabel(item);
      const date = document.createElement('time'); date.textContent = formatDate(item.starts_on);
      const detail = document.createElement('small');
      const frequency = item.settlement_frequency === 'weekly' ? 'Pagamento semanal' : 'Pagamento mensal';
      detail.textContent = item.active ? (item.itemized ? 'Cálculo separado por item · ' + frequency : 'Base: ' + (basisLabels[item.basis] || item.basis) + ' · ' + frequency) : 'Regra desativada';
      row.append(title, date, detail); list.appendChild(row);
    });
  }

  function memberId() {
    const match = window.location.hash.match(/^#equipe\/comissao\/([^/]+)$/);
    if (match) state.memberId = decodeURIComponent(match[1]); return state.memberId || '';
  }

  function url() { return Caixa.teamPath(memberId()) + '/comissao'; }
  function initials(name) {
    const words = String(name || 'Colaborador').trim().split(/\s+/);
    return (((words[0] && words[0][0]) || 'C') + ((words[1] && words[1][0]) || (words[0] && words[0][1]) || 'O')).toUpperCase();
  }

  function setMode(mode) {
    document.getElementById('team-commission-loading').classList.toggle('hidden', mode !== 'loading');
    document.getElementById('team-commission-error').classList.toggle('hidden', mode !== 'error');
    document.getElementById('team-commission-form').classList.toggle('hidden', mode !== 'content');
  }

  function selectedKind() {
    const radio = document.querySelector('input[name="team-commission-kind"]:checked');
    return radio ? radio.value : 'none';
  }

  function basesFor(kind) {
    const bases = (payload && payload.available_bases) || [];
    return bases.filter(function (basis) {
      return kind === 'percent' ? ['revenue', 'margin'].includes(basis) : ['sale', 'delivery', 'trip'].includes(basis);
    });
  }

  function renderBases(kind, preferred) {
    const select = document.getElementById('team-commission-basis'); select.replaceChildren();
    basesFor(kind).forEach(function (basis) {
      const option = document.createElement('option'); option.value = basis;
      option.textContent = basisLabels[basis] || basis; select.appendChild(option);
    });
    if (Array.from(select.options).some(function (option) { return option.value === preferred; })) select.value = preferred;
  }

  function refreshFields() {
    const kind = selectedKind(); const fields = document.getElementById('team-rule-fields');
    fields.classList.toggle('is-disabled', kind === 'none');
    const value = document.getElementById('team-commission-value'); value.disabled = kind === 'none';
    document.getElementById('team-commission-basis').disabled = kind === 'none';
    document.getElementById('team-commission-value-label').firstChild.textContent = kind === 'percent' ? 'Percentual' : 'Valor fixo';
    document.getElementById('team-commission-unit-symbol').textContent = kind === 'percent' ? '%' : 'R$';
    if (kind !== 'none') renderBases(kind, document.getElementById('team-commission-basis').value || payload.basis);
    const numeric = Number(value.value || 0);
    const example = kind === 'none' ? 0 : kind === 'percent' ? 1000 * numeric / 100 : numeric;
    document.getElementById('team-commission-example').querySelector('strong').textContent = 'Comissão: ' + Caixa.currency.format(example);
  }

  function salesRule() {
    const available = (payload && payload.available_bases) || [];
    return available.includes('revenue') && available.includes('sale');
  }

  function blankItemRules() {
    return {
      tire: { kind: 'none', value: 0 },
      service: { kind: 'none', value: 0 },
      other: { kind: 'none', value: 0 },
    };
  }

  function itemRulesFrom(data) {
    if (data.itemized && data.item_rules) return data.item_rules;
    const rules = blankItemRules();
    if (!data.active) return rules;
    if (data.kind === 'fixed') rules.tire = { kind: 'fixed', value: Number(data.value || 0) };
    else itemGroups.forEach(function (group) { rules[group] = { kind: 'percent', value: Number(data.value || 0) }; });
    return rules;
  }

  function readItemRules() {
    const result = blankItemRules();
    itemGroups.forEach(function (group) {
      const kind = document.getElementById('team-commission-' + group + '-kind').value;
      result[group] = {
        kind: kind,
        value: kind === 'none' ? 0 : Number(document.getElementById('team-commission-' + group + '-value').value || 0),
      };
    });
    return result;
  }

  function refreshItemRule(group) {
    const kind = document.getElementById('team-commission-' + group + '-kind').value;
    const input = document.getElementById('team-commission-' + group + '-value');
    const wrapper = input.closest('.team-item-rule-value');
    input.disabled = kind === 'none'; wrapper.classList.toggle('is-disabled', kind === 'none');
    if (kind === 'percent') input.max = '100'; else input.removeAttribute('max');
    document.getElementById('team-commission-' + group + '-symbol').textContent = kind === 'fixed' ? 'R$' : '%';
    const value = Number(input.value || 0);
    const example = group === 'tire'
      ? (kind === 'fixed' ? '2 pneus vendidos → ' + Caixa.currency.format(value * 2)
        : 'Pneu de R$ 200 → ' + Caixa.currency.format(200 * value / 100))
      : group === 'service'
        ? 'Serviço de R$ 25 → ' + Caixa.currency.format(kind === 'none' ? 0 : 25 * value / 100)
        : 'Item de R$ 100 → ' + Caixa.currency.format(kind === 'none' ? 0 : value);
    document.getElementById('team-commission-' + group + '-example').textContent = kind === 'none' ? 'Não gera comissão.' : example;
  }

  function renderItemRules(data) {
    const rules = itemRulesFrom(data);
    itemGroups.forEach(function (group) {
      document.getElementById('team-commission-' + group + '-kind').value = rules[group].kind;
      document.getElementById('team-commission-' + group + '-value').value = rules[group].value || '';
      refreshItemRule(group);
    });
    document.getElementById('team-commission-migration-note').classList.toggle('hidden', data.itemized || !data.active);
  }

  function render(data) {
    payload = data; const member = data.member;
    document.getElementById('team-commission-unit').textContent = data.unit_name;
    document.getElementById('team-commission-avatar').textContent = initials(member.name);
    document.getElementById('team-commission-name').textContent = member.name;
    document.getElementById('team-commission-role').textContent = member.role;
    document.getElementById('team-commission-status').textContent = member.active ? 'Ativo' : 'Inativo';
    const itemized = salesRule();
    document.getElementById('team-commission-legacy-rule').classList.toggle('hidden', itemized);
    document.getElementById('team-commission-itemized-rule').classList.toggle('hidden', !itemized);
    const kind = data.active ? data.kind : 'none';
    document.querySelectorAll('input[name="team-commission-kind"]').forEach(function (radio) {
      const available = radio.value === 'none' || basesFor(radio.value).length > 0;
      radio.disabled = !available; radio.closest('label').classList.toggle('is-unavailable', !available);
      radio.checked = radio.value === kind;
    });
    document.getElementById('team-commission-value').value = data.value || '';
    document.querySelectorAll('input[name="team-commission-frequency"]').forEach(function (radio) {
      radio.checked = radio.value === (data.settlement_frequency || 'monthly');
    });
    const start = document.getElementById('team-commission-start'); start.value = String(data.starts_on).slice(0, 10);
    if (Caixa.isPartner()) start.max = window.FarejadorTime.businessDate(); else start.removeAttribute('max');
    renderBases(data.kind, data.basis); refreshFields();
    if (itemized) renderItemRules(data);
    renderHistory(data.history || []);
    document.getElementById('team-commission-history').classList.add('hidden');
    const historyToggle = document.getElementById('team-commission-history-toggle');
    historyToggle.textContent = 'Ver histórico de regras'; historyToggle.setAttribute('aria-expanded', 'false');
    document.getElementById('team-commission-save-error').textContent = '';
    document.getElementById('team-open-finance-commission').classList.toggle(
      'hidden', !Caixa.canModule('financeiro'),
    );
  }

  async function load(force) {
    if (!memberId()) { Caixa.showTab('team'); return; }
    if (payload && payload.member.id === memberId() && !force) { render(payload); setMode('content'); return; }
    setMode('loading');
    try {
      const response = await Caixa.authenticatedFetch(url()); const data = await Caixa.json(response);
      if (!response.ok) throw new Error(data.error || 'request_failed'); render(data); setMode('content');
    } catch (error) {
      if (error instanceof Error && error.message === 'invalid_session') return; setMode('error');
    }
  }

  async function save(event) {
    event.preventDefault(); const kindChoice = selectedKind();
    const frequency = document.querySelector('input[name="team-commission-frequency"]:checked');
    let body;
    if (salesRule()) {
      const rules = readItemRules();
      const representative = itemGroups.map(function (group) { return rules[group]; })
        .find(function (rule) { return rule.kind !== 'none' && rule.value > 0; });
      body = {
        kind: representative && representative.kind === 'fixed' ? 'fixed' : 'percent',
        basis: representative && representative.kind === 'fixed' ? 'sale' : 'revenue',
        value: representative ? representative.value : 0,
        active: Boolean(representative), itemized: true, item_rules: rules,
        starts_on: document.getElementById('team-commission-start').value,
        settlement_frequency: frequency ? frequency.value : 'monthly',
      };
    } else {
      const fallbackKind = payload.kind || 'percent'; const kind = kindChoice === 'none' ? fallbackKind : kindChoice;
      const available = basesFor(kind); body = {
        kind: kind, basis: document.getElementById('team-commission-basis').value || available[0],
        value: kindChoice === 'none' ? 0 : Number(document.getElementById('team-commission-value').value || 0),
        active: kindChoice !== 'none', itemized: false, item_rules: blankItemRules(),
        starts_on: document.getElementById('team-commission-start').value,
        settlement_frequency: frequency ? frequency.value : 'monthly',
      };
    }
    const error = document.getElementById('team-commission-save-error'); error.textContent = '';
    const button = document.getElementById('team-commission-save'); button.disabled = true; button.textContent = 'Salvando…';
    try {
      const response = await Caixa.authenticatedFetch(url(), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await Caixa.json(response); if (!response.ok) throw new Error(data.error || 'request_failed');
      payload = data; state.payload = null; render(data); Caixa.showToast('Regra de comissão salva.');
    } catch (failure) {
      if (failure instanceof Error && failure.message === 'invalid_session') return;
      error.textContent = failure instanceof Error && failure.message === 'future_start_not_allowed'
        ? 'No parceiro, a vigência começa hoje ou em uma data anterior.' : 'Não foi possível salvar esta regra.';
    } finally { button.disabled = false; button.textContent = 'Salvar regra de comissão'; }
  }

  function back() { payload = null; state.memberId = ''; window.location.hash = '#equipe'; Caixa.showTab('team'); }
  function toggleHistory() {
    const history = document.getElementById('team-commission-history');
    const opening = history.classList.contains('hidden'); history.classList.toggle('hidden', !opening);
    const button = document.getElementById('team-commission-history-toggle');
    button.textContent = opening ? 'Ocultar histórico de regras' : 'Ver histórico de regras';
    button.setAttribute('aria-expanded', opening ? 'true' : 'false');
  }
  Object.assign(Caixa, { loadTeamCommission: load });
  document.getElementById('team-commission-form').addEventListener('submit', save);
  document.getElementById('team-commission-retry').addEventListener('click', function () { void load(true); });
  document.getElementById('team-commission-back').addEventListener('click', back);
  document.getElementById('team-commission-history-toggle').addEventListener('click', toggleHistory);
  document.getElementById('team-open-finance-commission').addEventListener('click', function () {
    if (Caixa.openFinanceCommissionDetail) Caixa.openFinanceCommissionDetail(memberId());
  });
  document.querySelectorAll('input[name="team-commission-kind"]').forEach(function (radio) { radio.addEventListener('change', refreshFields); });
  document.getElementById('team-commission-value').addEventListener('input', refreshFields);
  document.getElementById('team-commission-basis').addEventListener('change', refreshFields);
  itemGroups.forEach(function (group) {
    document.getElementById('team-commission-' + group + '-kind').addEventListener('change', function () { refreshItemRule(group); });
    document.getElementById('team-commission-' + group + '-value').addEventListener('input', function () { refreshItemRule(group); });
  });
}());
