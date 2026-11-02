(function () {
  'use strict';
  const C = window.Caixa, G = C.purchaseTrips, P = C.purchases, s = G.state;
  const paths = {
    plus: 'M12 4v16M4 12h16', back: 'M20 12H4m7-7-7 7 7 7', next: 'm9 5 7 7-7 7',
    cart: 'M3 3h2l3 13h11l3-10H6M10 21h.01M18 21h.01',
    wallet: 'M20 8V5a2 2 0 0 0-2-2H5a3 3 0 0 0 0 6h15v11H4V6m16 6h-5v5h5',
    fuel: 'M3 22V4h10v18M3 10h10M1 22h14M13 12h2a2 2 0 0 1 2 2v3a2 2 0 0 0 4 0V9l-4-4M18 6v4h3',
    food: 'M3 2v6a3 3 0 0 0 6 0V2M6 2v20M17 2c-3 5-3 9 0 10h3M20 2v20',
    road: 'M6 3 2 21h20L18 3M12 3v4m0 4v4m0 4v2',
    image: 'M3 3h18v18H3zM3 16l5-5 5 5 3-3 5 5M15 7h.01',
    camera: 'M8 5 10 2h4l2 3h5v15H3V5h5ZM16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
    info: 'M12 11v6m0-10h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
    check: 'm5 12 4 4L19 6', receipt: 'M5 3h14v19l-3-2-4 2-4-2-3 2V3Zm4 5h6m-6 4h6',
  };
  const node = (tag, cls, text) => P.el(tag, cls, text);
  const icon = name => C.createSvg([{ d: paths[name] || paths.receipt }]);
  const button = (text, action, primary, symbol) => { const b = P.button('', action, 'vg-button' + (primary ? ' vg-primary' : ''));
    if (symbol) b.append(icon(symbol)); b.append(node('span', '', text)); return b; };
  const money = value => value == null || !Number.isFinite(Number(value)) ? '—' : C.currency.format(Number(value));
  const line = (name, amount, symbol) => { const row = node('div', 'vg-line'); if (symbol) row.append(icon(symbol));
    row.append(node('span', '', name), node('strong', '', money(amount))); return row; };
  const card = cls => node('section', 'vg-card ' + (cls || ''));
  const categoryIcon = text => /combust|gasolina|posto/i.test(text) ? 'fuel' : /alimenta|restaur|lanche|comida/i.test(text) ? 'food' : /ped[aá]gio/i.test(text) ? 'road' : 'receipt';
  function list() {
    const host = G.id('content'); host.replaceChildren(button('Nova viagem', () => G.dialogs.create(), true, 'plus'));
    if (!s.rows.length) host.append(node('p', 'vg-empty', 'Crie uma viagem para reunir as compras e os gastos da sua saída.'));
    s.rows.forEach(group => {
      const box = card('vg-trip-card'), header = node('div', 'vg-card-top'); header.append(node('span', '', group.code), node('span', 'vg-badge', group.status === 'open' ? 'Aberta' : 'Fechada'));
      box.append(header, node('h3', '', group.name), node('p', '', group.summary.tires + ' pneus' + (group.suppliers_count != null ? ' · ' + group.suppliers_count + ' fornecedores' : '')));
      box.append(node('p', 'vg-total-label', 'Total da viagem'), node('strong', 'vg-total', money(group.summary.total)), node('p', 'vg-cost-pill', money(group.summary.cost_per_tire) + ' por pneu'));
      box.append(line('Compras', group.summary.purchases, 'cart'), line('Gastos', group.summary.expenses, 'wallet'));
      if (group.summary.provisional) box.append(node('p', 'vg-muted', 'Provisório · compras a conferir'));
      box.append(button('Abrir viagem', () => G.open(group.id), false, 'next')); host.append(box);
    });
    const pages = node('div', 'vg-pagination');
    const prev = button('Anterior', () => { s.page--; void G.load(); }); prev.disabled = s.page === 1;
    const next = button('Próxima', () => { s.page++; void G.load(); }); next.disabled = !s.more;
    pages.append(prev, node('span', '', 'Página ' + s.page), next); host.append(pages);
  }
  function expenseRow(expense) {
    const row = node('article', 'vg-expense-row' + (expense.deleted_at ? ' vg-removed' : ''));
    row.append(icon(categoryIcon(expense.category_label || expense.category)));
    const text = node('div', 'vg-row-copy'); text.append(node('strong', '', expense.category_label), node('small', '', expense.description || P.day(expense.occurred_at)));
    if (expense.receipt_id) { const photo = button('Ver comprovante', () => G.receipt(expense), false, 'image'); photo.classList.add('vg-photo-link');
      const image = node('img', 'vg-receipt-mini'); image.alt = ''; photo.prepend(image); text.append(photo); G.thumbnail(expense.receipt_id, image); }
    if (expense.deleted_at) text.append(node('small', '', 'Removida'));
    row.append(text, node('strong', 'vg-row-amount', money(expense.amount)));
    const more = button('Detalhes do gasto', () => G.dialogs.expense(expense), false, 'next'); more.classList.add('vg-row-more'); row.append(more); return row;
  }
  function purchaseRow(purchase) {
    const row = node('article', 'vg-expense-row' + (purchase.status === 'cancelled' ? ' vg-removed' : ''));
    row.append(icon('cart')); const copy = node('div', 'vg-row-copy');
    const open = P.button(purchase.supplier_name, () => P.openDetail(purchase, false), 'vg-text-button');
    copy.append(open, node('small', '', (purchase.order_code || 'Compra') + ' · ' + purchase.items_count + ' pneus'),
      node('small', '', purchase.status === 'cancelled' ? 'Cancelada' : purchase.stock_applied ? 'Recebida' : 'Em trânsito'));
    row.append(copy, node('strong', 'vg-row-amount', money(purchase.total_amount)));
    const openDetail = button('Detalhes da compra', () => P.openDetail(purchase, false), false, 'next'); openDetail.classList.add('vg-row-more'); row.append(openDetail);
    return row;
  }
  function detail() {
    const d = s.detail, host = G.id('content'); if (!d) return;
    host.replaceChildren(); const top = node('header', 'vg-heading'), back = button('', G.list, false, 'back'); back.setAttribute('aria-label', 'Voltar às viagens');
    const title = node('div'); title.append(node('h2', '', d.group.name), node('p', '', d.group.code + ' · Viagem ' + (d.group.status === 'open' ? 'aberta' : 'fechada'))); top.append(back, title); host.append(top);
    const hero = card('vg-hero'); hero.append(node('p', '', 'Custo por pneu com os gastos'), node('strong', 'vg-total', money(d.summary.cost_per_tire)),
      node('p', '', d.summary.tires + ' pneus · ' + money(d.summary.total) + ' no total'));
    if (d.summary.provisional) hero.append(node('small', '', 'Provisório — falta conferir ' + d.summary.pending_purchases + ' compra(s)'));
    host.append(hero); const note = node('p', 'vg-info'); note.append(icon('info'), node('span', '', 'O custo no estoque não muda.'));
    note.title = 'Inclui gastos da viagem. O custo do pneu no estoque continua sendo só a compra (pneu + frete do fornecedor).'; host.append(note);
    const totals = node('div', 'vg-summary-pair'); totals.append(line('Compras', d.summary.purchases, 'cart'), line('Gastos', d.summary.expenses, 'wallet')); host.append(totals);
    const tabs = node('div', 'vg-tabs'); [['purchases', 'Compras'], ['expenses', 'Gastos']].forEach(([key, label]) => {
      const b = button(label, () => { s.tab = key; detail(); }); b.setAttribute('aria-pressed', String(s.tab === key)); tabs.append(b);
    }); host.append(tabs);
    const rows = node('div', 'vg-records'); (s.tab === 'expenses' ? d.expenses : d.purchases).forEach(row => rows.append(s.tab === 'expenses' ? expenseRow(row) : purchaseRow(row)));
    if (!rows.childElementCount) rows.append(node('p', 'vg-empty', s.tab === 'expenses' ? 'Nenhum gasto nesta viagem.' : 'Escolha esta viagem ao cadastrar a compra ou vincule pelo detalhe da compra.'));
    host.append(rows);
    if (d.summary.freight_warning) host.append(node('p', 'vg-warning', 'Tem frete nas compras e frete nos gastos — confere se não é o mesmo.'));
    if (d.group.status === 'open') {
      host.append(button('Gasto', () => G.expense.launch(d.group), true, 'plus'), button('Puxar despesa já lançada', () => G.dialogs.eligible(1), false, 'receipt'));
      const rules = node('details', 'vg-rules'); rules.append(node('summary', '', 'Como lançar o frete'), node('p', '', 'Frete cobrado pelo fornecedor vai na compra dele. Caminhão ou transportadora que trouxe a carga vai aqui como gasto (modalidade Frete pago).')); host.append(rules);
    }
    const footer = node('div', 'vg-footer'); footer.append(button(d.group.status === 'open' ? 'Fechar viagem' : 'Reabrir viagem', () => G.action(d.group.status === 'open' ? 'close' : 'reopen')),
      button('Editar viagem', () => G.dialogs.create('rename')));
    if (!d.purchases.length && !d.expenses.length) footer.append(button('Excluir viagem vazia', () => G.dialogs.remove()));
    host.append(footer);
  }
  G.view = { node, icon, button, money, line, card, list, detail, categoryIcon };
}());
