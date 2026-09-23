(function () {
  'use strict';
  const C = window.Caixa, V = C.financeView, el = id => document.getElementById(id);
  const state = { direction: 'out', status: 'open', search: '', category: 'all', offset: 0, payload: null };
  let request, timer;
  const categories = { fornecedor: 'Compra de pneus', despesa: 'Despesa', folha: 'Remuneração da equipe', marketing: 'Marketing',
    fiado: 'Venda a prazo', varejo: 'Venda na Matriz', comissao: 'Comissão da rede', mensalidade: 'Mensalidade',
    estorno_comissao: 'Devolução de comissão', devolucao_cliente: 'Devolução ao cliente', devolucao_fornecedor: 'Devolução do fornecedor', devolucao_despesa: 'Devolução de despesa' };
  const dateLabel = date => date ? window.FarejadorTime.formatDate(date) : 'Sem vencimento';
  function cancel() { if (request) request.abort(); request = null; clearTimeout(timer); }
  function reset() { cancel(); state.payload = null; state.search = ''; state.offset = 0; state.direction = 'out'; state.status = 'open'; state.category = 'all'; el('ma-search').value = ''; el('ma-category').value = 'all'; el('ma-list').replaceChildren(); el('ma-content').classList.add('hidden'); }
  function detail(row) {
    const body = V.dialog(row.nome);
    if (row.tipo === 'despesa') C.financeReceipts?.attachment(body, row.id);
    V.lines(body, [['Saldo em aberto', V.money(row.valor)]], true);
    V.lines(body, [['Tipo', categories[row.tipo] || 'Conta'], ['Vencimento', dateLabel(row.due_date)], ['Situação', row.overdue ? 'Vencida' : 'Em aberto']], false);
    if (row.tipo === 'folha') body.appendChild(V.node('p', 'Este valor pode incluir salário, benefícios, comissões e ajustes. A baixa paga o total desta remuneração.'));
    if (row.settlement_mode && C.stored(C.keys.role) === 'owner') {
      const button = V.node('button', state.direction === 'out' ? 'Conferir e pagar' : 'Conferir recebimento', 'mf-primary'); button.type = 'button';
      button.addEventListener('click', () => C.financePayment.account(row, state.direction, () => { if (C.financeMatrix.currentTab() === 'accounts') void C.financeMatrix.load(); })); body.appendChild(button);
    } else body.appendChild(V.node('p', 'O proprietário pode registrar a baixa desta conta.'));
  }
  function card(row, today) {
    const item = V.node('button', undefined, 'ma-card'); item.type = 'button';
    const visual = V.node('span', undefined, 'mf-icon-circle mf-in'); visual.appendChild(V.icon(row.tipo === 'fornecedor' ? 'purchase' : row.tipo === 'folha' ? 'team' : 'expense'));
    const copy = V.node('span', undefined, 'ma-copy'); copy.append(V.node('strong', row.nome), V.node('small', (categories[row.tipo] || 'Conta') + (row.due_date ? ' · ' + dateLabel(row.due_date) : '')));
    const side = V.node('span', undefined, 'ma-value'), amount = V.node('b'); V.amount(amount, V.money(row.valor)); side.appendChild(amount);
    if (row.overdue || row.due_date === today) side.appendChild(V.node('small', row.overdue ? 'Vencida' : 'Vence hoje', 'mf-badge ' + (row.overdue ? 'is-late' : '')));
    const action = V.node('span', 'Ver conta ', 'ma-action'); action.appendChild(V.icon('arrow')); side.appendChild(action);
    item.append(visual, copy, side); item.addEventListener('click', () => detail(row)); return item;
  }
  function renderOpen() {
    if (!state.payload) return;
    const group = state.payload.agenda[state.direction === 'out' ? 'a_pagar' : 'a_receber'];
    const today = window.FarejadorTime.dateKey(new Date()), search = state.search.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const rows = group.itens.filter(r => (state.status !== 'overdue' || r.overdue) && (state.category === 'all' || state.category === r.tipo)
      && [r.nome, categories[r.tipo], r.categoria].join(' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().includes(search));
    const list = el('ma-list'); list.replaceChildren();
    if (!rows.length) list.appendChild(V.node('p', 'Nenhuma conta encontrada para esses filtros.', 'mf-empty'));
    const groups = [['Vencidas', r => r.overdue], ['Vence hoje · ' + dateLabel(today), r => !r.overdue && r.due_date === today],
      ['Próximos vencimentos', r => r.due_date && r.due_date > today], ['Sem vencimento informado', r => !r.due_date]];
    groups.forEach(([title, filter]) => {
      const items = rows.filter(filter).sort((a, b) => String(a.due_date || '').localeCompare(String(b.due_date || '')));
      if (!items.length) return;
      list.appendChild(V.node('h4', title, 'ma-group-title')); items.forEach(row => list.appendChild(card(row, today)));
    });
    el('ma-count').textContent = rows.length + (rows.length === 1 ? ' conta' : ' contas'); el('ma-pagination').classList.add('hidden');
  }
  function controls() {
    document.querySelectorAll('[data-ma-direction]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.maDirection === state.direction)));
    document.querySelectorAll('[data-ma-status]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.maStatus === state.status)));
    el('ma-settled-tab').textContent = state.direction === 'out' ? 'Pagas' : 'Recebidas';
    el('ma-search').placeholder = state.direction === 'out' ? 'Buscar conta ou fornecedor' : 'Buscar conta ou cliente';
    el('ma-scope').textContent = state.status === 'settled' ? 'Pagamentos e recebimentos do mês selecionado, conforme o extrato.' : 'Posição atual · inclui vencimentos de outros meses.';
    el('ma-category').disabled = state.status === 'settled';
    el('ma-note').textContent = state.direction === 'out' ? 'Pagar uma conta registra a saída no caixa.' : 'Receber uma conta registra a entrada no caixa.';
  }
  async function load() {
    cancel(); if (!C.token() || C.isPartner() || !C.canModule('financeiro')) return;
    const controller = new AbortController(); request = controller;
    const session = C.sessionFingerprint(), month = C.financeMatrix.period();
    const valid = () => !controller.signal.aborted && C.sessionFingerprint() === session && C.financeMatrix.currentTab() === 'accounts' && C.financeMatrix.period() === month;
    controls(); el('ma-content').classList.add('hidden'); el('ma-error').classList.add('hidden'); el('ma-loading').classList.remove('hidden');
    try {
      const response = await C.authenticatedFetch('/api/caixa/financeiro-simples?period=' + month, { signal: controller.signal });
      const payload = await C.json(response); if (!response.ok || payload.source !== 'central_ledger' || payload.period !== month || !payload.agenda) throw Error('invalid_accounts');
      if (!valid()) return;
      V.amount('ma-payable', V.money(payload.agenda.a_pagar.total)); V.amount('ma-receivable', V.money(payload.agenda.a_receber.total)); state.payload = payload;
      el('ma-warning').classList.toggle('hidden', payload.integration_status !== 'yellow');
      if (state.status === 'settled') {
        const params = new URLSearchParams({ period: month, direction: state.direction, search: state.search, offset: String(state.offset), limit: '25' });
        const res = await C.authenticatedFetch('/api/caixa/financeiro-extrato?' + params, { signal: controller.signal });
        const result = await C.json(res); if (!res.ok || result.source !== 'central_ledger' || result.period !== month || !Array.isArray(result.rows)) throw Error('invalid_accounts');
        if (!valid()) return;
        if (result.total && state.offset >= result.total) { state.offset = 0; return load(); }
        V.movements('ma-list', result.rows, false, Boolean(state.search));
        el('ma-pagination').classList.toggle('hidden', !result.total); el('ma-prev').disabled = state.offset === 0; el('ma-next').disabled = state.offset + result.rows.length >= result.total;
        el('ma-page-count').textContent = (result.total ? state.offset + 1 : 0) + '–' + (state.offset + result.rows.length) + ' de ' + result.total;
        el('ma-count').textContent = result.total + ' movimentações';
      } else renderOpen();
      el('ma-loading').classList.add('hidden'); el('ma-content').classList.remove('hidden'); C.financeMatrix.updated();
    } catch (error) {
      if (!valid() || error.message === 'invalid_session') return;
      state.payload = null; el('ma-loading').classList.add('hidden'); el('ma-error').classList.remove('hidden');
    } finally { if (request === controller) request = null; }
  }
  document.querySelectorAll('[data-ma-direction]').forEach(b => b.addEventListener('click', () => { state.direction = b.dataset.maDirection; state.offset = 0; void load(); }));
  document.querySelectorAll('[data-ma-status]').forEach(b => b.addEventListener('click', () => { state.status = b.dataset.maStatus; state.offset = 0; void load(); }));
  el('ma-search').addEventListener('input', () => { cancel(); state.search = el('ma-search').value.trim(); state.offset = 0; if (state.status === 'settled') { el('ma-content').classList.add('hidden'); timer = setTimeout(load, 250); } else renderOpen(); });
  el('ma-filters').addEventListener('click', () => { const panel = el('ma-filter-panel'); panel.classList.toggle('hidden'); el('ma-filters').setAttribute('aria-expanded', String(!panel.classList.contains('hidden'))); });
  el('ma-category').addEventListener('change', () => { state.category = el('ma-category').value; renderOpen(); });
  el('ma-retry').addEventListener('click', load);
  el('ma-prev').addEventListener('click', () => { state.offset = Math.max(0, state.offset - 25); void load(); });
  el('ma-next').addEventListener('click', () => { state.offset += 25; void load(); });
  C.financeAccounts = { load, cancel, reset };
}());
