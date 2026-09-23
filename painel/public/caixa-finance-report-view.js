(function () {
  'use strict';
  const C = window.Caixa, V = C.financeView, T = window.FarejadorTime, el = id => document.getElementById(id);
  const origin = value => ({ all: 'Todas as origens', varejo: 'Varejo', atacado: 'Atacado', compras: 'Compras', despesas: 'Despesas',
    marketing: 'Marketing', comissao: 'Comissões da rede', mensalidades: 'Mensalidades', estoque: 'Estoque', financeiro: 'Financeiro', outros: 'Outras origens' }[value] || value);
  const category = value => ({ aluguel: 'Aluguel', funcionario: 'Equipe', combustivel: 'Combustível', marketing: 'Marketing',
    energia: 'Energia', agua: 'Água', internet: 'Internet', estoque: 'Perdas / uso interno', operacao: 'Operação', outros: 'Outras despesas' }[value] || String(value || 'Outras despesas').replaceAll('_', ' '));
  function box(title) { const node = V.node('section', undefined, 'mt-card'); node.appendChild(V.node('h3', title)); return node; }
  function values(target, title, rows) { const card = box(title); V.lines(card, rows.map(([name, value]) => [name, V.money(value)]), true); target.appendChild(card); }
  function render(data, tab) {
    const s = data.summary, summary = el('mr-summary'), breakdown = el('mr-breakdown'), expenses = el('mr-expenses');
    [summary, breakdown, expenses].forEach(n => n.replaceChildren());
    el('mr-warning').classList.toggle('hidden', !s.partial);
    el('mr-warning').textContent = s.pending_revenue > 0 ? 'Resultado parcial: ' + V.money(s.pending_revenue) + ' de vendas com custo pendente estão fora do resultado conhecido.'
      : 'Há pendências de integração. Confira a conciliação no Financeiro web antes de considerar o resultado completo.';
    if (tab === 'result' || tab === 'overview') {
      const hero = V.node('section', undefined, 'mr-result' + (s.result < 0 ? ' is-negative' : ''));
      const visual = V.node('span', undefined, 'mf-icon-circle'); visual.appendChild(V.icon('chart'));
      const content = V.node('div'), value = V.node('strong'); V.amount(value, V.money(s.result));
      content.append(V.node('span', s.partial ? 'Resultado parcial do período' : 'Resultado do período'), value, V.node('small', 'Vendas menos custos e despesas'));
      hero.append(visual, content); summary.appendChild(hero);
      const card = box('Composição do resultado');
      const rows = [['Vendas', s.revenue, 1], ['Custo dos pneus', s.cost, -1], ['Despesas', s.expense, -1]];
      if (s.inventory_loss) rows.push(['Perdas de estoque', s.inventory_loss, -1]);
      if (s.pending_revenue) rows.push(['Vendas com custo pendente', s.pending_revenue, -1]);
      if (s.inventory_gain) rows.push(['Ganhos de estoque', s.inventory_gain, 1]);
      const max = Math.max(1, ...rows.map(r => Math.abs(r[1])));
      rows.forEach(([label, amount, sign]) => {
        const row = V.node('div', undefined, 'mr-composition'), bar = V.node('span', undefined, 'mr-bar'), fill = V.node('i'), value = V.node('b');
        fill.style.width = Math.min(100, Math.abs(amount) / max * 100) + '%'; if (sign > 0) fill.classList.add('is-in'); bar.appendChild(fill);
        V.amount(value, (sign < 0 ? '− ' : '') + V.money(amount)); row.append(V.node('span', label), bar, value); card.appendChild(row);
      });
      V.lines(card, [[s.partial ? 'Resultado parcial' : 'Resultado', V.money(s.result)]], true); breakdown.appendChild(card);
      if (data.expenses.length) values(expenses, 'Despesas por categoria', data.expenses.map(r => [category(r.category), r.amount]));
      else expenses.appendChild(V.node('p', 'Nenhuma despesa registrada neste período.', 'mf-empty'));
      if (tab === 'overview') {
        values(expenses, 'Caixa no período', [['Saldo anterior', s.opening], ['Entradas', s.incoming], ['Saídas', s.outgoing], ['Saldo ao final', s.closing]]);
        values(expenses, 'Contas em aberto hoje', [['A receber', data.position.receivable], ['A pagar', data.position.payable]]);
      }
      el('mr-note').textContent = 'Resultado e saldo em caixa são diferentes. Os totais consideram período e origem; a busca filtra os lançamentos abaixo.';
    } else if (tab === 'cash') {
      values(summary, 'Caixa no período', [['Saldo anterior', s.opening], ['Entradas', s.incoming], ['Saídas', s.outgoing], ['Saldo ao final', s.closing]]);
      values(breakdown, 'Movimentações filtradas', [['Entradas', data.cash_filtered.incoming], ['Saídas', data.cash_filtered.outgoing]]);
      el('mr-note').textContent = 'Saldo anterior + entradas − saídas = saldo ao final. Direção e busca filtram a lista; os saldos usam todo o período e a origem.';
    } else {
      values(summary, 'Contas em aberto hoje', [['A receber', data.position.receivable], ['A pagar', data.position.payable], ['Vencido a receber', data.position.overdue_receivable], ['Vencido a pagar', data.position.overdue_payable]]);
      el('mr-note').textContent = 'Posição atual, incluindo contas de outros meses. Os totais usam a origem; tipo, vencimento e busca filtram a lista abaixo.';
    }
    el('mr-records-label').textContent = tab === 'titles' ? 'Contas encontradas' : tab === 'cash' ? 'Movimentações do caixa' : 'Lançamentos do resultado';
  }
  function detail(row, tab) {
    const body = V.dialog(tab === 'titles' ? 'Detalhes da conta' : 'Lançamento do resultado');
    if (row.origin === 'despesas') C.financeReceipts?.attachment(body, row.source_id);
    body.appendChild(V.node('p', row.name || row.description));
    if (tab === 'titles') {
      V.lines(body, [['Saldo em aberto', V.money(row.amount)]], true);
      V.lines(body, [['Tipo', row.side === 'payable' ? 'A pagar' : 'A receber'], ['Vencimento', row.due_on ? T.formatDate(row.due_on) : 'Sem vencimento'], ['Origem', origin(row.origin)]], false);
      const button = V.node('button', 'Abrir Contas', 'mf-primary'); button.type = 'button'; button.addEventListener('click', () => C.financeMatrix.open('accounts')); body.appendChild(button);
    } else {
      V.lines(body, [['Receitas', V.money(row.revenue)], ['Custo dos pneus', V.money(row.cost)], ['Despesas', V.money(row.expense)], ['Ganhos de estoque', V.money(row.gain)], ['Perdas de estoque', V.money(row.loss)], ['Efeito registrado', V.money(row.result)]], true);
      V.lines(body, [['Competência', T.formatDate(row.competence_on)], ['Origem', origin(row.origin)], ['Referência', row.reference || row.source_id]], false);
      if (row.reversal_of || row.reversed) body.appendChild(V.node('p', row.reversal_of ? 'Este lançamento é um estorno.' : 'Este lançamento tem estorno posterior, apresentado separadamente.'));
    }
  }
  function list(data, tab, page) {
    const rows = tab === 'titles' ? data.titles : tab === 'cash' ? data.cash_rows : data.result_rows;
    const offset = page * 25, visible = rows.slice(offset, offset + 25), host = el('mr-list'); host.replaceChildren();
    if (tab === 'cash') V.movements('mr-list', visible, false, Boolean(data.filters.search || data.filters.direction !== 'all'));
    else {
      visible.forEach(row => {
        const button = V.node('button', undefined, 'mf-entry'), copy = V.node('span', undefined, 'mf-entry-copy'), value = V.node('b', undefined, 'mf-entry-amount'); button.type = 'button';
        copy.append(V.node('strong', row.name || row.description), V.node('small', tab === 'titles'
          ? (row.side === 'payable' ? 'A pagar' : 'A receber') + ' · ' + (row.due_on ? T.formatDate(row.due_on) : 'Sem vencimento')
          : T.formatDate(row.competence_on) + ' · ' + origin(row.origin)));
        V.amount(value, V.money(tab === 'titles' ? row.amount : row.result)); button.append(copy, value, V.icon('chevron'));
        button.addEventListener('click', () => detail(row, tab)); host.appendChild(button);
      });
      if (!rows.length) host.appendChild(V.node('p', 'Nenhum registro encontrado para esses filtros.', 'mf-empty'));
    }
    el('mr-count').textContent = (rows.length ? offset + 1 : 0) + '–' + Math.min(offset + 25, rows.length) + ' de ' + rows.length;
    el('mr-prev').disabled = page === 0; el('mr-next').disabled = offset + 25 >= rows.length;
  }
  C.financeReportView = { render, list, origin, category };
}());
