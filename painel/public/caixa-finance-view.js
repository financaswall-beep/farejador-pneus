(function () {
  'use strict';
  const C = window.Caixa, el = id => document.getElementById(id);
  let masked = false;
  const paths = {
    filters: ['M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6m-8 0v6'],
    settings: ['M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z'],
    wallet: ['M3 6h18v15H3zM3 6l14-4v4M15 11h6v6h-6zM17 14h1'],
    calendar: ['M4 5h16v16H4zM8 3v4m8-4v4M4 10h16'],
    'chevron-down': ['m7 10 5 5 5-5'], chevron: ['m9 5 7 7-7 7'], back: ['m15 5-7 7 7 7'],
    arrow: ['M4 12h16m-6-6 6 6-6 6'], refresh: ['M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 14 6M4 12a8 8 0 0 0 14 6'],
    eye: ['M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12', 'M9 12a3 3 0 1 0 6 0 3 3 0 0 0-6 0'],
    in: ['M12 4v16m-6-6 6 6 6-6'], out: ['M6 18 18 6M6 6h12v12'],
    chart: ['M5 20V10h3v10M11 20V4h3v16M17 20V8h3v12'],
    tire: ['M12 2C2 2 2 22 12 22s10-20 0-20M12 5c-6 0-6 14 0 14s6-14 0-14M12 5c-2 0-2 14 0 14M7 4C2 12 7 20 7 20M17 4c5 8 0 16 0 16'],
    team: ['M5 7a3 3 0 1 0 6 0 3 3 0 0 0-6 0M15 6a2 2 0 1 0 4 0 2 2 0 0 0-4 0M2 21v-4a6 6 0 0 1 12 0v4M17 12a5 5 0 0 1 5 5v4'],
    expense: ['M6 3h8l4 4v14H6zM14 3v5h5M9 14h6m-3-3v6'],
    search: ['M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14M15 15l6 6'], close: ['m6 6 12 12M6 18 18 6'],
    info: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 11v6M12 7v.2'], plus: ['M12 4v16M4 12h16'],
    sale: ['M4 7h16l-1 14H5zM8 9V6a4 4 0 0 1 8 0v3'],
    purchase: ['m4 7 8-4 8 4-8 4zM4 7v10l8 4 8-4V7M12 11v10M8 5l8 4v5'],
  };
  function icon(name) { return C.createSvg((paths[name] || paths.expense).map(d => ({ d }))); }
  document.querySelectorAll('[data-mf-icon]').forEach(node => node.appendChild(icon(node.dataset.mfIcon)));
  function node(tag, text, className) {
    const item = document.createElement(tag);
    if (text !== undefined) item.textContent = text;
    if (className) item.className = className;
    return item;
  }
  function number(value) {
    if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) throw Error('finance_payload_invalid');
    return Number(value);
  }
  const money = value => C.currency.format(number(value));
  function amount(target, value) {
    const item = typeof target === 'string' ? el(target) : target;
    item.dataset.mfMoney = value;
    item.textContent = masked ? '••••' : value;
  }
  function privacy(value) {
    masked = value;
    el('matrix-finance-panel').querySelectorAll('[data-mf-money]').forEach(item => {
      item.textContent = masked ? '••••' : (item.dataset.mfMoney || '—');
    });
    el('mf-privacy').setAttribute('aria-pressed', String(masked));
    el('mf-privacy').setAttribute('aria-label', masked ? 'Mostrar valores' : 'Ocultar valores');
  }
  function dialog(title) {
    el('mf-detail-title').textContent = title;
    const body = el('mf-detail-body'); body.replaceChildren();
    if (!el('mf-detail').open) el('mf-detail').showModal();
    return body;
  }
  function lines(body, rows, financial) {
    const list = node('dl');
    rows.forEach(([label, value]) => {
      const row = node('div'), description = node('dd');
      if (financial) amount(description, value); else description.textContent = value;
      row.append(node('dt', label), description); list.appendChild(row);
    }); body.appendChild(list);
  }
  function summary(payload, currentMonth) {
    const result = payload.truth.competencia, cash = payload.truth.caixa;
    const value = number(result.lucro_confirmado), pending = number(result.receita_custo_pendente);
    if (!['confirmado', 'custo_pendente', 'divergente'].includes(result.status)) throw Error('finance_payload_invalid');
    const divergent = result.status === 'divergente';
    const partial = !divergent && (result.status === 'custo_pendente' || payload.integration_status === 'yellow');
    const card = el('mf-result-card');
    card.classList.toggle('is-uncertain', divergent);
    card.classList.toggle('is-partial', partial);
    card.classList.toggle('is-negative', value < 0 && !divergent && !partial);
    card.classList.toggle('is-neutral', value === 0 && !divergent && !partial);
    el('mf-result-label').textContent = divergent ? 'Resultado indisponível' : partial ? 'Resultado parcial'
      : value > 0 ? 'Lucro do mês' : value < 0 ? 'Prejuízo do mês' : 'Resultado zerado';
    amount('mf-result', divergent ? '—' : money(value));
    amount('mf-balance', money(cash.saldo_atual));
    amount('mf-incoming', money(cash.entradas_registradas)); amount('mf-outgoing', money(cash.saidas_registradas));
    el('mf-balance-label').textContent = payload.period === currentMonth ? 'SALDO EM CAIXA' : 'SALDO AO FIM DO MÊS';
    const warning = el('mf-warning'); warning.classList.toggle('hidden', !divergent && !partial);
    warning.textContent = divergent ? 'Há divergências na apuração. Confira a conciliação no Financeiro web.'
      : pending > 0 ? 'Há vendas com custo pendente. O resultado ainda está incompleto.'
        : 'Há pendências de integração. Confira a conciliação antes de considerar o resultado completo.';
    const stock = payload.inventory;
    amount('mf-stock-value', stock ? money(stock.capital) : 'Indisponível');
    el('mf-stock-note').textContent = !stock ? 'Posição de estoque indisponível' : stock.sem_custo > 0
      ? stock.sem_custo + ' pneus sem custo · valor parcial' : number(stock.pneus) + ' pneus · custo atual';
    el('mf-stock').disabled = !stock;
    el('mf-commissions').disabled = C.stored(C.keys.role) !== 'owner';
  }
  function resultDetail(payload) {
    const r = payload.truth.competencia, body = dialog('Como o resultado foi formado');
    body.appendChild(node('p', 'Competência: ' + payload.period.split('-').reverse().join('/')));
    const rows = [['Vendas', money(r.receita_total)], ['Custo dos pneus vendidos', '− ' + money(r.custo_conhecido)], ['Despesas e perdas', '− ' + money(r.despesas)]];
    if (number(r.receita_custo_pendente)) rows.push(['Vendas com custo pendente, fora do resultado', '− ' + money(r.receita_custo_pendente)]);
    if (number(r.ajustes_estoque.ganhos)) rows.push(['Ganhos de estoque', '+ ' + money(r.ajustes_estoque.ganhos)]);
    rows.push([el('mf-result-label').textContent, r.status === 'divergente' ? 'Indisponível' : money(r.lucro_confirmado)]);
    lines(body, rows, true);
    if (payload.expenses.length) {
      body.appendChild(node('h4', 'Despesas registradas'));
      lines(body, payload.expenses.map(row => [row.label, money(row.amount)]), true);
    }
    body.appendChild(node('p', 'O saldo em caixa considera recebimentos e pagamentos. O lucro considera as vendas, o custo dos produtos vendidos e as despesas da competência.'));
    body.appendChild(node('p', 'A estimativa de consumo de IA do bot não é descontada automaticamente.'));
  }
  const origins = { varejo: 'Venda na Matriz', atacado: 'Venda no atacado', compras: 'Compra de estoque', despesas: 'Despesa', marketing: 'Marketing', comissao: 'Comissão da rede', mensalidades: 'Mensalidade', estoque: 'Estoque', financeiro: 'Financeiro', outros: 'Movimentação' };
  const day = value => new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(value + 'T12:00:00Z'));
  function entry(row, preview) {
    const incoming = number(row.cash_in), outgoing = number(row.cash_out);
    const article = node('button', undefined, 'mf-entry ' + (incoming > 0 ? 'is-in' : 'is-out')); article.type = 'button';
    const visual = node('span', undefined, 'mf-icon-circle ' + (incoming > 0 ? 'mf-in' : 'mf-out'));
    visual.appendChild(icon(['varejo', 'atacado'].includes(row.origin) ? 'sale' : row.origin === 'compras' ? 'purchase' : 'expense'));
    const copy = node('span', undefined, 'mf-entry-copy');
    copy.append(node('strong', row.description || origins[row.origin] || 'Movimentação'), node('small',
      [preview ? day(row.cash_on) : row.reference || origins[row.origin], row.reversal_of ? 'Estorno' : row.reversed ? 'Estornado posteriormente' : ''].filter(Boolean).join(' · ')));
    const value = node('span', undefined, 'mf-entry-amount');
    amount(value, [incoming > 0 ? '+ ' + money(incoming) : '', outgoing > 0 ? '− ' + money(outgoing) : ''].filter(Boolean).join(' / '));
    article.append(visual, copy, value, icon('chevron'));
    article.addEventListener('click', () => {
      const body = dialog('Detalhes do lançamento');
      body.appendChild(node('p', row.description || 'Movimentação financeira'));
      const values = [];
      if (incoming) values.push(['Entrada no caixa', money(incoming)]);
      if (outgoing) values.push(['Saída do caixa', money(outgoing)]);
      lines(body, values, true);
      lines(body, [['Data do caixa', C.dateTime.format(new Date(row.cash_on + 'T12:00:00-03:00')).split(',')[0]],
        ['Origem', origins[row.origin] || 'Financeiro'], ['Referência', row.reference || 'Não informada'],
        ['Forma de pagamento', row.payment_method || 'Não informada'], ['Conta', row.cash_account || 'Não informada']], false);
      if (row.reversal_of || row.reversed) body.appendChild(node('p', row.reversal_of ? 'Este lançamento registra um estorno.' : 'Este lançamento tem um estorno posterior, apresentado separadamente no extrato.'));
    });
    return article;
  }
  function movements(target, rows, preview, search) {
    const list = el(target); list.replaceChildren();
    if (!rows.length) { list.appendChild(node('p', search ? 'Nenhuma movimentação encontrada para esses filtros.' : 'Nenhuma movimentação neste mês.', 'mf-empty')); return; }
    if (preview) { rows.forEach(row => list.appendChild(entry(row, true))); return; }
    const groups = new Map();
    rows.forEach(row => { if (!groups.has(row.cash_on)) groups.set(row.cash_on, []); groups.get(row.cash_on).push(row); });
    groups.forEach((items, date) => {
      const section = node('section'), header = node('header', undefined, 'mf-day-heading');
      header.append(node('h4', day(date)), node('span', items.length + (items.length === 1 ? ' lançamento' : ' lançamentos')));
      section.appendChild(header); items.forEach(row => section.appendChild(entry(row, false))); list.appendChild(section);
    });
  }
  C.financeView = { icon, node, number, money, amount, privacy, dialog, lines, summary, resultDetail, movements };
}());
