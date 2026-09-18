(function () {
  'use strict';
  const C = window.Caixa, el = id => document.getElementById(id);
  const month = el('finance-month-input'), detailMonth = el('finance-entries-month');
  const currentMonth = () => window.FarejadorTime.dateKey(new Date()).slice(0, 7);
  let agenda = null, agendaKind = '';
  const text = (id, value) => { el(id).textContent = value; };
  const number = value => {
    if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) {
      throw new Error('finance_payload_invalid');
    }
    return Number(value);
  };
  const money = value => C.currency.format(number(value));

  function configureFinancePeriod() {
    const matrix = !C.isPartner();
    const max = currentMonth();
    if (!month.value) month.value = max;
    month.max = max; detailMonth.max = max; detailMonth.value = month.value;
    month.classList.toggle('hidden', !matrix); detailMonth.classList.toggle('hidden', !matrix);
    el('finance-period-input').classList.toggle('hidden', matrix);
    el('finance-entries-range').classList.toggle('hidden', matrix);
    month.parentElement.classList.toggle('is-month', matrix);
    document.querySelectorAll('[data-finance-matrix]').forEach(node => node.classList.toggle('hidden', !matrix));
  }
  function financePeriodQuery() {
    if (C.isPartner()) return 'range=' + encodeURIComponent(el('finance-period-input').value || '30d');
    const value = month.value;
    if (!/^(?:20|21)\d{2}-(0[1-9]|1[0-2])$/.test(value) || value > currentMonth()) throw new Error('invalid_month');
    return 'period=' + encodeURIComponent(value);
  }
  function syncFinanceMonth(value) { month.value = value; detailMonth.value = value; }
  function lines(target, rows) {
    const list = el(target); list.replaceChildren();
    rows.forEach(([label, value]) => {
      const row = document.createElement('div'), title = document.createElement('dt'), amount = document.createElement('dd');
      title.textContent = label; amount.textContent = money(value); row.append(title, amount); list.appendChild(row);
    });
  }
  function renderMonthlyFinance(payload) {
    if (payload.source !== 'central_ledger' || !payload.truth || payload.period !== month.value) {
      throw new Error('finance_payload_invalid');
    }
    const result = payload.truth.competencia, cash = payload.truth.caixa;
    const value = number(result.lucro_confirmado);
    if (!['confirmado', 'custo_pendente', 'divergente'].includes(result.status)
      || !['green', 'yellow'].includes(payload.integration_status)) throw new Error('finance_payload_invalid');
    const divergent = result.status === 'divergente';
    const partial = !divergent && (result.status === 'custo_pendente' || payload.integration_status === 'yellow');
    const uncertain = divergent || partial;
    const negative = value < 0 && !uncertain;
    const hero = el('finance-hero');
    el('session-view').classList.toggle('finance-negative', negative);
    hero.classList.toggle('finance-hero--negative', negative);
    hero.classList.toggle('finance-hero--positive', value > 0 && !uncertain);
    hero.classList.toggle('finance-hero--uncertain', uncertain);
    hero.classList.toggle('finance-hero--neutral', value === 0 && !uncertain);
    text('finance-result-label', divergent ? 'Resultado indisponível' : partial ? 'Resultado parcial do mês'
      : value > 0 ? 'Lucro apurado no mês' : value < 0 ? 'Prejuízo apurado no mês' : 'Resultado zerado no mês');
    text('finance-net', divergent ? '—' : money(value));
    const label = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' })
      .format(new Date(payload.period + '-01T12:00:00Z'));
    text('finance-hero-note', 'Por competência · ' + label);
    el('finance-status').querySelector('b').textContent = uncertain ? 'Há pendências para conferir' : 'Com base nos lançamentos registrados';
    const warning = el('finance-warning');
    warning.classList.toggle('hidden', !uncertain);
    warning.textContent = divergent ? 'Há divergências na apuração. Confira a conciliação no Financeiro web.'
      : number(result.receita_custo_pendente) > 0
        ? money(result.receita_custo_pendente) + ' em vendas com custo pendente. O resultado ainda está incompleto.'
        : 'Existem pendências de integração no financeiro. Confira no painel antes de considerar o resultado completo.';
    const composition = [['Receitas reconhecidas', result.receita_total]];
    if (number(result.receita_custo_pendente) > 0) composition.push(['Receitas fora do resultado por custo pendente (−)', result.receita_custo_pendente]);
    composition.push(['Custo dos produtos vendidos (−)', result.custo_conhecido],
      ['Despesas e perdas (−)', result.despesas], ['Ganhos de estoque (+)', result.ajustes_estoque.ganhos]);
    lines('finance-composition-values', composition);
    lines('finance-expense-values', payload.expenses.map(row => [row.label, row.amount]));
    if (!payload.expenses.length) el('finance-expense-values').textContent = 'Nenhuma despesa registrada no mês.';
    text('finance-balance-label', payload.period === currentMonth() ? 'Saldo em caixa no mês atual' : 'Saldo em caixa ao fim do mês');
    text('finance-balance', money(cash.saldo_atual)); text('finance-opening', money(cash.saldo_anterior));
    text('finance-movement', money(cash.movimento_liquido));
    text('finance-in', money(cash.entradas_registradas)); text('finance-out', money(cash.saidas_registradas));
    text('finance-cash-heading', 'Caixa · ' + label);
    agenda = payload.agenda; agendaKind = ''; el('finance-agenda').classList.add('hidden');
    text('finance-receivable', money(agenda.a_receber.total) + ' a receber');
    text('finance-payable', money(agenda.a_pagar.total) + ' a pagar');
    const today = window.FarejadorTime.dateKey(new Date());
    const due = agenda.a_pagar.itens.filter(row => row.due_date === today);
    text('finance-due', due.length ? due.length + ' conta(s) vencem hoje' : 'Nenhuma conta vence hoje');
    text('finance-commission-label', 'Comissões da equipe');
    text('finance-commission-total', 'Consultar períodos'); text('finance-commission-count', 'Apuração e pagamentos');
    el('finance-commissions').classList.toggle('hidden', C.stored(C.keys.role) !== 'owner');
  }
  function toggleFinanceAgenda(kind) {
    if (C.isPartner() || !agenda || !['receivable', 'payable', 'due'].includes(kind)) return;
    const box = el('finance-agenda');
    if (agendaKind === kind && !box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
    agendaKind = kind;
    const rows = kind === 'receivable' ? agenda.a_receber.itens : kind === 'due'
      ? agenda.a_pagar.itens.filter(row => row.due_date === window.FarejadorTime.dateKey(new Date())) : agenda.a_pagar.itens;
    text('finance-agenda-title', kind === 'receivable' ? 'A receber — posição atual' : kind === 'due' ? 'Vencem hoje' : 'A pagar — posição atual');
    const list = el('finance-agenda-list'); list.replaceChildren();
    rows.forEach(row => {
      const item = document.createElement('article'), name = document.createElement('strong');
      const value = document.createElement('b'), date = document.createElement('small');
      name.textContent = row.nome; value.textContent = money(row.valor);
      date.textContent = row.due_date ? (row.overdue ? 'Vencida · ' : 'Vencimento · ') + window.FarejadorTime.formatDate(row.due_date) : 'Sem vencimento';
      item.append(name, value, date); list.appendChild(item);
    });
    if (!rows.length) list.textContent = 'Nenhuma pendência neste grupo.';
    box.classList.remove('hidden');
  }
  Object.assign(C, { configureFinancePeriod, financePeriodQuery, syncFinanceMonth, renderMonthlyFinance, toggleFinanceAgenda });
}());
