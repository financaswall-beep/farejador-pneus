(function () {
  'use strict';

  const Caixa = window.Caixa;
  const state = Caixa.teamState;
  let payload = null;

  const basisLabels = {
    revenue: 'Valor final da venda', margin: 'Margem da venda', sale: 'Por venda',
    delivery: 'Por entrega concluída', trip: 'Por rota concluída',
  };

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

  function render(data) {
    payload = data; const member = data.member;
    document.getElementById('team-commission-unit').textContent = data.unit_name;
    document.getElementById('team-commission-avatar').textContent = initials(member.name);
    document.getElementById('team-commission-name').textContent = member.name;
    document.getElementById('team-commission-role').textContent = member.role;
    document.getElementById('team-commission-status').textContent = member.active ? 'Ativo' : 'Inativo';
    const kind = data.active ? data.kind : 'none';
    document.querySelectorAll('input[name="team-commission-kind"]').forEach(function (radio) {
      const available = radio.value === 'none' || basesFor(radio.value).length > 0;
      radio.disabled = !available; radio.closest('label').classList.toggle('is-unavailable', !available);
      radio.checked = radio.value === kind;
    });
    document.getElementById('team-commission-value').value = data.value || '';
    const start = document.getElementById('team-commission-start'); start.value = String(data.starts_on).slice(0, 10);
    if (Caixa.isPartner()) start.max = new Date().toISOString().slice(0, 10); else start.removeAttribute('max');
    renderBases(data.kind, data.basis); refreshFields();
    document.getElementById('team-commission-save-error').textContent = '';
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
    const fallbackKind = payload.kind || 'percent'; const kind = kindChoice === 'none' ? fallbackKind : kindChoice;
    const available = basesFor(kind); const body = {
      kind: kind, basis: document.getElementById('team-commission-basis').value || available[0],
      value: kindChoice === 'none' ? 0 : Number(document.getElementById('team-commission-value').value || 0),
      active: kindChoice !== 'none', starts_on: document.getElementById('team-commission-start').value,
    };
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
  Object.assign(Caixa, { loadTeamCommission: load });
  document.getElementById('team-commission-form').addEventListener('submit', save);
  document.getElementById('team-commission-retry').addEventListener('click', function () { void load(true); });
  document.getElementById('team-commission-back').addEventListener('click', back);
  document.querySelectorAll('input[name="team-commission-kind"]').forEach(function (radio) { radio.addEventListener('change', refreshFields); });
  document.getElementById('team-commission-value').addEventListener('input', refreshFields);
  document.getElementById('team-commission-basis').addEventListener('change', refreshFields);
}());
