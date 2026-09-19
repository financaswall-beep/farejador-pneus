(function () {
  'use strict';
  const C = window.Caixa, V = C.financeView, el = id => document.getElementById(id);
  let request, detailRequest, payload = null, tab = 'payable';
  const date = value => value ? window.FarejadorTime.formatDate(String(value).slice(0, 10)) : 'Não informada';
  function cancel() { if (request) request.abort(); if (detailRequest) detailRequest.abort(); request = null; detailRequest = null; }
  function reset() { cancel(); payload = null; tab = 'payable'; el('mc-list').replaceChildren(); el('mc-content').classList.add('hidden'); }
  function rule(person) {
    if (person.commission_itemized) return 'Por tipo de item';
    if (!person.commission_kind) return 'Sem regra ativa';
    return person.commission_kind === 'percent' ? Number(person.commission_value).toLocaleString('pt-BR') + '%' : V.money(person.commission_value);
  }
  const basis = { margin: 'Margem', revenue: 'Vendas', sale: 'Por venda', delivery: 'Por entrega', trip: 'Por rota' };
  function showRules() {
    if (!payload) return;
    const body = V.dialog('Regras de comissão');
    body.appendChild(V.node('p', 'Regras atuais da equipe. Os fechamentos preservam os valores apurados na época.'));
    if (!payload.collaborators.length) body.appendChild(V.node('p', 'Nenhuma regra para exibir.'));
    payload.collaborators.forEach(person => {
      body.appendChild(V.node('h4', person.name));
      V.lines(body, [['Regra', rule(person)], ['Base', basis[person.commission_basis] || 'Por item'], ['Fechamento', person.frequency === 'weekly' ? 'Semanal' : 'Mensal']], false);
      if (person.commission_itemized) Object.entries(person.commission_item_rules || {}).forEach(([key, r]) => {
        V.lines(body, [[{ tire: 'Pneus', service: 'Serviços', other: 'Outros' }[key] || key,
          r.kind === 'none' ? 'Sem comissão' : r.kind === 'percent' ? r.value + '%' : V.money(r.value) + ' por item']], false);
      });
    });
  }
  function card(person, settlement) {
    const row = V.node('article', undefined, 'mc-person');
    const head = V.node('div', undefined, 'mc-person-head');
    const words = (person.name || '').trim().split(/\s+/), avatar = V.node('span', (words[0]?.[0] || 'C') + (words.at(-1)?.[0] || ''), 'mc-avatar');
    const identity = V.node('div'); identity.append(V.node('strong', person.name), V.node('small', person.role || 'Colaborador'));
    const amount = V.node('b'); V.amount(amount, V.money(settlement ? settlement.commission_amount : person.commission_amount)); head.append(avatar, identity, amount); row.appendChild(head);
    const meta = V.node('div', undefined, 'mc-person-meta');
    if (settlement) {
      meta.append(V.node('span', date(settlement.period_start) + ' a ' + date(settlement.period_end)), V.node('span', settlement.status === 'paid' ? 'Paga · ' + date(settlement.paid_at) : 'Vence em ' + date(settlement.due_on)));
    } else {
      const base = V.node('span', (person.commission_basis === 'margin' ? 'Base: margem' : 'Base: vendas') + ' '), value = V.node('b');
      V.amount(value, V.money(person.commission_basis === 'margin' ? person.margin : person.gross_sales)); base.appendChild(value);
      meta.append(base, V.node('span', 'Regra atual · ' + rule(person)));
    }
    row.appendChild(meta);
    const footer = V.node('div', undefined, 'mc-person-footer');
    footer.appendChild(V.node('small', settlement ? (settlement.frequency === 'monthly' ? 'Fechamento mensal' : 'Fechamento semanal') : 'Em apuração · aguardando fechamento'));
    const open = V.node('button', 'Ver apuração ', 'mf-outline'); open.type = 'button'; open.appendChild(V.icon('arrow'));
    open.addEventListener('click', () => detail(person.id || settlement.collaborator_id, settlement)); footer.appendChild(open); row.appendChild(footer);
    return row;
  }
  function render() {
    if (!payload) return;
    const s = payload.summary; ['accrued', 'paid', 'payable'].forEach(key => V.amount('mc-' + key, V.money(s[key])));
    document.querySelectorAll('[data-mc-tab]').forEach(b => b.setAttribute('aria-current', b.dataset.mcTab === tab ? 'page' : 'false'));
    const list = el('mc-list'); list.replaceChildren();
    const settlements = payload.settlements.filter(r => tab === 'history' || r.status === (tab === 'paid' ? 'paid' : 'pending'));
    const people = new Set();
    settlements.forEach(r => { people.add(r.collaborator_id); const person = payload.collaborators.find(p => p.id === r.collaborator_id) || { id: r.collaborator_id, name: r.name, role: r.role }; list.appendChild(card(person, r)); });
    if (tab === 'payable') {
      const open = payload.collaborators.filter(p => V.number(p.commission_amount) !== 0 && (p.frequency === 'weekly' || !payload.settlements.some(s => s.collaborator_id === p.id)));
      if (open.length) list.appendChild(V.node('h4', 'Apuração do mês', 'ma-group-title'));
      open.forEach(p => { people.add(p.id); list.appendChild(card(p)); });
    }
    if (!list.children.length) list.appendChild(V.node('p', tab === 'paid' ? 'Nenhuma comissão paga nesta competência.' : tab === 'history' ? 'Nenhum fechamento nesta competência.' : 'Nenhuma comissão a pagar ou em apuração.', 'mf-empty'));
    el('mc-count').textContent = people.size + (people.size === 1 ? ' colaborador' : ' colaboradores');
    el('mc-pay').disabled = !payload.settlements.some(s => s.status === 'pending' && V.number(s.payment_total) > 0);
    V.amount('mc-payment-total', V.money(s.payment_total));
    el('mc-note').textContent = 'Pagas e a pagar consideram os fechamentos desta competência. A apuração pode incluir valores ainda não fechados.';
  }
  async function load() {
    cancel(); if (!C.token() || C.isPartner() || C.stored(C.keys.role) !== 'owner') return;
    const controller = new AbortController(); request = controller;
    const session = C.sessionFingerprint(), period = C.financeMatrix.period();
    const valid = () => !controller.signal.aborted && session === C.sessionFingerprint() && C.financeMatrix.currentTab() === 'commissions' && C.financeMatrix.period() === period;
    payload = null; el('mc-content').classList.add('hidden'); el('mc-error').classList.add('hidden'); el('mc-loading').classList.remove('hidden');
    try {
      const res = await C.authenticatedFetch('/api/caixa/financeiro-comissoes-mes?period=' + period, { signal: controller.signal });
      const body = await C.json(res);
      if (!res.ok || body.period !== period || !Array.isArray(body.collaborators) || !Array.isArray(body.settlements)) throw Error('invalid_commissions');
      if (!valid()) return; payload = body; render(); el('mc-loading').classList.add('hidden'); el('mc-content').classList.remove('hidden'); C.financeMatrix.updated(new Date(body.as_of));
    } catch (error) { if (!valid() || error.message === 'invalid_session') return; el('mc-loading').classList.add('hidden'); el('mc-error').classList.remove('hidden'); }
    finally { if (request === controller) request = null; }
  }
  async function detail(id, settlement, offset = 0) {
    if (detailRequest) detailRequest.abort(); const controller = new AbortController(); detailRequest = controller;
    const session = C.sessionFingerprint(), period = C.financeMatrix.period();
    const body = V.dialog('Apuração da comissão'), loading = V.node('p', 'Conferindo a apuração…'); body.appendChild(loading);
    try {
      const params = new URLSearchParams({ period, offset: String(offset) }); if (settlement) params.set('target', settlement.id);
      const res = await C.authenticatedFetch('/api/caixa/financeiro-comissoes-mes/' + encodeURIComponent(id) + '?' + params, { signal: controller.signal });
      const data = await C.json(res); if (!res.ok) throw Error('detail_failed');
      if (controller.signal.aborted || session !== C.sessionFingerprint() || !el('mf-detail').open || !body.contains(loading) || C.financeMatrix.period() !== period) return;
      const person = data.person || data.settlement; body.replaceChildren(V.node('h4', person.name));
      if (data.settlement) {
        const s = data.settlement;
        V.lines(body, [['Comissão no fechamento', V.money(s.commission_amount)], ['Total da remuneração', V.money(s.payment_total)]], true);
        body.appendChild(V.node('p', date(s.period_start) + ' a ' + date(s.period_end) + ' · ' + (s.status === 'paid' ? 'Paga em ' + date(s.paid_at) : 'A pagar')));
        body.appendChild(V.node('p', 'O valor do fechamento é preservado. Os eventos abaixo mostram a consulta atual das vendas e entregas.'));
        if (s.status === 'pending' && V.number(s.payment_total) > 0) {
          const button = V.node('button', 'Conferir pagamento', 'mf-primary'); button.type = 'button'; button.addEventListener('click', () => confirmPayment(s)); body.appendChild(button);
        }
      } else {
        V.lines(body, [['Comissão apurada', V.money(person.commission_amount)]], true);
        body.appendChild(V.node('p', 'Aguardando fechamento ' + (person.frequency === 'weekly' ? 'semanal.' : 'mensal.')));
      }
      if (person.missing_cost_items) body.appendChild(V.node('p', 'Há itens sem custo. Comissões sobre margem podem estar incompletas.', 'mf-warning'));
      body.appendChild(V.node('h4', 'Vendas e entregas da apuração'));
      if (!data.sales.length) body.appendChild(V.node('p', 'Nenhum evento encontrado neste recorte.'));
      data.sales.forEach(r => { V.lines(body, [[r.reference + ' · ' + date(r.occurred_at), V.money(r.commission_amount)]], true); });
      if (data.total > 50 || offset) {
        body.appendChild(V.node('p', (offset + 1) + '–' + (offset + data.sales.length) + ' de ' + data.total + ' eventos'));
        const nav = V.node('div', undefined, 'mf-pagination');
        [['Anterior', Math.max(0, offset - 50), offset === 0], ['Próxima', offset + 50, offset + data.sales.length >= data.total]].forEach(([text, next, disabled]) => {
          const button = V.node('button', text); button.type = 'button'; button.disabled = disabled; button.addEventListener('click', () => detail(id, settlement, next)); nav.appendChild(button);
        }); body.appendChild(nav);
      }
    } catch (error) { if (!controller.signal.aborted && session === C.sessionFingerprint() && body.contains(loading)) body.replaceChildren(V.node('p', 'Não foi possível conferir a apuração. Feche e tente novamente.')); }
  }
  function confirmPayment(s) {
    const body = V.dialog('Confirmar pagamento'); body.appendChild(V.node('h4', s.name));
    V.lines(body, [['Comissão', V.money(s.commission_amount)], ['Valor que sairá do caixa', V.money(s.payment_total)]], true);
    body.appendChild(V.node('p', s.frequency === 'monthly' ? 'Este pagamento quita a remuneração inteira do fechamento, incluindo salário, benefícios e ajustes quando houver.' : 'Este pagamento quita a comissão semanal selecionada.'));
    body.appendChild(V.node('p', 'O pagamento será registrado com a data atual.'));
    const button = V.node('button', 'Confirmar pagamento · ' + V.money(s.payment_total), 'mf-primary'); button.type = 'button';
    const error = V.node('p', '', 'mf-inline-error hidden'); error.setAttribute('role', 'alert'); body.append(error, button);
    const session = C.sessionFingerprint();
    button.addEventListener('click', async () => {
      button.disabled = true; error.classList.add('hidden');
      try {
        const res = await C.authenticatedFetch('/api/caixa/financeiro-comissoes/' + encodeURIComponent(s.collaborator_id) + '/pagar', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ payment_target_id: s.id, idempotency_key: 'operation-commission-' + s.id }) });
        const result = await C.json(res); if (!res.ok) throw Error(result.error || 'payment_failed');
        if (session !== C.sessionFingerprint()) return; if (body.contains(button)) el('mf-detail').close(); C.showToast('Pagamento registrado no Financeiro.');
        if (C.financeMatrix.currentTab() === 'commissions') void C.financeMatrix.load();
      } catch (failure) {
        if (session !== C.sessionFingerprint()) return;
        error.textContent = 'Não foi possível confirmar. Atualize as comissões para conferir a situação antes de tentar novamente.';
        error.classList.remove('hidden'); button.textContent = 'Atualizar comissões';
        // Não reenvia o pagamento quando a resposta é incerta.
        const refresh = button.cloneNode(true); refresh.disabled = false; refresh.addEventListener('click', () => { el('mf-detail').close(); void C.financeMatrix.load(); }); button.replaceWith(refresh);
      }
    });
  }
  function choosePayment() {
    if (!payload) return; const body = V.dialog('Escolha o fechamento para pagar');
    body.appendChild(V.node('p', 'Confira cada fechamento antes de confirmar seu pagamento.'));
    payload.settlements.filter(s => s.status === 'pending' && V.number(s.payment_total) > 0).forEach(s => {
      const button = V.node('button', s.name + ' · ' + V.money(s.payment_total), 'mf-outline mc-payment-choice'); button.type = 'button';
      button.addEventListener('click', () => detail(s.collaborator_id, s)); body.appendChild(button);
    });
  }
  document.querySelectorAll('[data-mc-tab]').forEach(b => b.addEventListener('click', () => { tab = b.dataset.mcTab; render(); }));
  el('mc-rules').addEventListener('click', showRules); el('mc-retry').addEventListener('click', load); el('mc-pay').addEventListener('click', choosePayment);
  C.financeCommissionMonth = { load, cancel, reset };
}());
