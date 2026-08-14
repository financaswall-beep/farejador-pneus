(function () {
  'use strict';

  const Caixa = window.Caixa;
  const state = Caixa.teamState;
  let payload = null;

  function memberId() {
    if (state.memberId) return state.memberId;
    const match = window.location.hash.match(/^#equipe\/remuneracao\/([^/]+)$/);
    state.memberId = match ? decodeURIComponent(match[1]) : ''; return state.memberId;
  }

  function url() { return Caixa.teamPath(memberId()) + '/remuneracao'; }
  function initials(name) {
    const words = String(name || 'Colaborador').trim().split(/\s+/);
    return ((words[0] && words[0][0]) || 'C') + ((words[1] && words[1][0]) || (words[0] && words[0][1]) || 'O');
  }

  function setMode(mode) {
    document.getElementById('team-remuneration-loading').classList.toggle('hidden', mode !== 'loading');
    document.getElementById('team-remuneration-error').classList.toggle('hidden', mode !== 'error');
    document.getElementById('team-remuneration-form').classList.toggle('hidden', mode !== 'content');
  }

  function moneyValue(value) {
    const number = Number(value || 0); return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
  }

  function benefitRow(benefit) {
    const row = document.createElement('div'); row.className = 'team-benefit-row';
    const name = document.createElement('input'); name.maxLength = 60; name.placeholder = 'Nome do benefício';
    name.value = benefit.name || '';
    const amount = document.createElement('input'); amount.type = 'number'; amount.min = '0'; amount.step = '0.01';
    amount.placeholder = 'R$ 0,00'; amount.value = moneyValue(benefit.amount) || '';
    const active = document.createElement('input'); active.type = 'checkbox'; active.className = 'team-benefit-toggle';
    active.checked = benefit.active !== false; active.setAttribute('aria-label', 'Benefício ativo');
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×';
    remove.setAttribute('aria-label', 'Remover benefício'); remove.addEventListener('click', function () { row.remove(); updateSummary(); });
    [name, amount, active].forEach(function (input) { input.addEventListener('input', updateSummary); });
    row.append(name, amount, active, remove); return row;
  }

  function readBenefits() {
    return Array.from(document.querySelectorAll('.team-benefit-row')).flatMap(function (row) {
      const inputs = row.querySelectorAll('input'); const name = inputs[0].value.trim();
      if (!name) return [];
      return [{ name: name, amount: moneyValue(inputs[1].value), active: inputs[2].checked }];
    });
  }

  function updateSummary() {
    const salary = moneyValue(document.getElementById('team-base-salary').value);
    const benefits = readBenefits().reduce(function (sum, item) { return sum + (item.active ? item.amount : 0); }, 0);
    document.getElementById('team-summary-salary').textContent = Caixa.currency.format(salary);
    document.getElementById('team-summary-benefits').textContent = Caixa.currency.format(benefits);
    document.getElementById('team-summary-fixed').textContent = Caixa.currency.format(salary + benefits);
  }

  function render(data) {
    payload = data; const member = data.member;
    document.getElementById('team-remuneration-unit').textContent = data.unit_name;
    document.getElementById('team-remuneration-avatar').textContent = initials(member.name).toUpperCase();
    document.getElementById('team-remuneration-name').textContent = member.name;
    document.getElementById('team-remuneration-role').textContent = member.role;
    document.getElementById('team-remuneration-status').textContent = member.active ? 'Ativo' : 'Inativo';
    document.getElementById('team-base-salary').value = data.base_salary || '';
    document.getElementById('team-payment-day').value = data.payment_day || 5;
    const start = document.getElementById('team-compensation-start'); start.value = String(data.starts_on).slice(0, 10);
    if (Caixa.isPartner()) start.max = new Date().toISOString().slice(0, 10); else start.removeAttribute('max');
    document.getElementById('team-employment-type').value = data.employment_type || 'outro';
    const benefits = document.getElementById('team-benefits'); benefits.replaceChildren();
    (data.benefits || []).forEach(function (item) { benefits.appendChild(benefitRow(item)); });
    updateSummary(); document.getElementById('team-remuneration-save-error').textContent = '';
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
    event.preventDefault(); const error = document.getElementById('team-remuneration-save-error'); error.textContent = '';
    const button = document.getElementById('team-remuneration-save'); button.disabled = true; button.textContent = 'Salvando…';
    const body = {
      employment_type: document.getElementById('team-employment-type').value,
      base_salary: moneyValue(document.getElementById('team-base-salary').value),
      payment_day: Number(document.getElementById('team-payment-day').value),
      payment_method: payload.payment_method || 'pix',
      starts_on: document.getElementById('team-compensation-start').value, benefits: readBenefits(),
    };
    try {
      const response = await Caixa.authenticatedFetch(url(), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await Caixa.json(response); if (!response.ok) throw new Error(data.error || 'request_failed');
      payload = data; state.payload = null; render(data); Caixa.showToast('Remuneração salva com segurança.');
    } catch (failure) {
      if (failure instanceof Error && failure.message === 'invalid_session') return;
      error.textContent = failure instanceof Error && failure.message === 'future_start_not_allowed'
        ? 'No parceiro, a vigência começa hoje ou em uma data anterior.' : 'Não foi possível salvar. Confira os campos.';
    } finally { button.disabled = false; button.textContent = 'Salvar remuneração'; }
  }

  function back() { payload = null; state.memberId = ''; window.location.hash = '#equipe'; Caixa.showTab('team'); }
  Object.assign(Caixa, { loadTeamRemuneration: load });
  document.getElementById('team-remuneration-form').addEventListener('submit', save);
  document.getElementById('team-remuneration-retry').addEventListener('click', function () { void load(true); });
  document.getElementById('team-remuneration-back').addEventListener('click', back);
  document.getElementById('team-base-salary').addEventListener('input', updateSummary);
  document.getElementById('team-add-benefit').addEventListener('click', function () {
    const rows = document.querySelectorAll('.team-benefit-row');
    if (rows.length >= 12) return Caixa.showToast('Limite de 12 benefícios por colaborador.');
    document.getElementById('team-benefits').appendChild(benefitRow({ name: '', amount: 0, active: true }));
  });
  document.getElementById('team-open-commission').addEventListener('click', function () {
    window.location.hash = '#equipe/comissao/' + encodeURIComponent(memberId()); Caixa.showTab('team-commission');
  });
}());
