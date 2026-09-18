(function () {
  'use strict';
  const C = window.Caixa, P = C.purchases, s = P.state;
  let selected = null, receiving = false, key = '';
  const inputs = new Map();
  function error(message) { P.id('detail-error').textContent = message; P.id('detail-error').hidden = !message; }
  function locks() {
    const locked = s.busy || !!s.pending;
    inputs.forEach(function (input) { input.disabled = locked; });
    P.id('detail-close').disabled = s.busy;
    P.id('confirm-receipt').disabled = s.busy || (!!s.pending && s.pending.suffix !== '/confirmar');
    P.id('confirm-receipt').textContent = s.busy ? 'Confirmando…' : s.pending ? 'Tentar confirmar novamente' : 'Confirmar recebimento';
  }
  P.openDetail = function (row, receive) {
    if (!row) return;
    if (s.pending?.suffix === '/confirmar') { row = s.pending.detail; receive = true; }
    selected = row; receiving = receive && row.status === 'pending'; key = crypto.randomUUID(); inputs.clear(); error('');
    P.id('detail-title').textContent = receiving ? 'Conferir chegada' : 'Compra ' + P.reference(row);
    const host = P.id('detail'); host.replaceChildren();
    const summary = P.el('div', 'pc-card pc-stack'); summary.append(P.el('h3', '', row.supplier_name),
      P.el('p', 'pc-muted', 'Compra ' + P.reference(row) + ' · ' + P.date(row.purchased_at)), P.statuses(row));
    if (row.supplier_reference) summary.append(P.el('p', 'pc-muted', 'Referência: ' + row.supplier_reference));
    host.append(summary);
    const lot = row.purchase_kind === 'lot';
    const items = P.el('div', 'pc-card pc-stack'); items.append(P.el('h3', '', receiving ? 'Quantidade que chegou' : 'Pneus da compra'));
    (row.items || []).forEach(function (item) {
      const quantity = item.accepted_quantity ?? item.quantity;
      const ordered = item.ordered_quantity ?? item.quantity;
      const line = P.el('div', 'pc-receipt-row'); const description = P.el('div');
      description.append(P.el('strong', '', lot ? 'Lote fechado' : item.measure + ' · ' + (item.brand || 'Sem marca')),
        P.el('p', 'pc-muted', (lot ? '' : P.condition(item.tire_condition) + ' · ') + ordered + ' pedidos'));
      if (receiving && !lot) {
        const label = P.el('label', '', 'Recebidos'); const input = P.el('input');
        input.type = 'number'; input.inputMode = 'numeric'; input.min = '0'; input.max = ordered; input.step = '1'; input.required = true;
        input.value = s.pending?.body.items?.find(function (i) { return i.item_id === item.id; })?.accepted_quantity ?? ordered;
        input.setAttribute('aria-label', 'Recebidos de ' + item.measure + ' ' + (item.brand || ''));
        inputs.set(item.id, input); label.append(input); line.append(description, label);
      } else {
        description.append(P.el('p', 'pc-muted', quantity + ' pneus · ' + (lot ? 'Valor do lote' : P.money(item.unit_cost) + ' por unidade')));
        line.append(description, P.el('strong', '', P.money(lot ? item.line_total : Number(quantity) * Number(item.unit_cost))));
      }
      items.append(line);
    });
    host.append(items);
    const amounts = P.el('div', 'pc-card'); amounts.append(P.reviewLine('Produtos', P.money(row.products_amount)),
      P.reviewLine('Frete', P.money(row.freight_amount)), P.reviewLine('Desconto', '− ' + P.money(row.discount_amount)),
      P.reviewLine(receiving ? 'Total registrado' : 'Total', P.money(row.total_amount)));
    if (row.payment_status === 'pending') {
      (row.installments || []).forEach(function (item) { amounts.append(P.reviewLine('Parcela ' + item.number + ' · ' + P.day(item.due_date), P.money(item.amount))); });
      if (!row.installments?.length && row.due_date) amounts.append(P.reviewLine('Vencimento', P.day(row.due_date)));
    } else if (row.paid_at) amounts.append(P.reviewLine('Pagamento', P.date(row.paid_at)));
    if (row.payment_method) amounts.append(P.reviewLine('Forma', row.payment_method));
    host.append(amounts);
    if (receiving) host.append(P.el('p', 'pc-notice', lot
      ? 'Confirme somente se o lote inteiro chegou. Ele ficará disponível para triagem no web. Se a quantidade estiver errada, corrija a compra no web antes de receber.'
      : 'Esta conferência encerra o recebimento. Informe apenas os pneus aceitos, incluindo zero para os que não chegaram. O total da compra, o estoque e o financeiro serão ajustados pelas quantidades conferidas.'));
    if (s.pending) error(s.pending.suffix === '/confirmar'
      ? 'A última confirmação não teve resposta. Retome a mesma tentativa com as quantidades preservadas.'
      : 'Há uma compra aguardando confirmação. Feche os detalhes e toque em Nova compra para retomá-la.');
    if (row.notes) host.append(P.el('p', 'pc-muted', row.notes));
    if (row.cancel_reason) host.append(P.el('p', 'pc-notice', 'Cancelamento: ' + row.cancel_reason));
    P.id('confirm-receipt').hidden = !receiving; locks();
    if (!P.id('dialog').open) P.id('dialog').showModal();
  };
  P.id('confirm-receipt').addEventListener('click', async function () {
    if (!selected || !receiving || s.busy || (s.pending && s.pending.suffix !== '/confirmar')) return;
    error('');
    const body = { purchase_id: selected.id, idempotency_key: key };
    if (selected.purchase_kind !== 'lot') {
      body.items = []; let total = 0;
      for (const [id, input] of inputs) {
        if (!s.pending && !input.checkValidity()) { input.reportValidity(); return; }
        const quantity = Number(input.value); total += quantity;
        body.items.push({ item_id: id, accepted_quantity: quantity });
      }
      if (!total && !s.pending) { error('Informe pelo menos um pneu recebido. Para cancelar a compra, use o web.'); return; }
    }
    const operation = P.send('/confirmar', body, selected); locks();
    try {
      const result = await operation; if (!result) return;
      P.id('dialog').close();
      P.notice('Recebimento confirmado. Estoque e financeiro atualizados.' + (selected.purchase_kind === 'lot' ? ' Lote disponível para triagem no web.' : '') +
        (result.catalog_blockers?.length ? ' Complete os pneus indicados no Catálogo para liberar a venda.' : ''), true);
      void P.load(); void P.summary();
    } catch (failure) { if (failure.message !== 'invalid_session') error(P.message(failure)); }
    finally { locks(); }
  });
  P.id('detail-close').addEventListener('click', function () { if (!s.busy) P.id('dialog').close(); });
  P.id('dialog').addEventListener('cancel', function (event) { if (s.busy) event.preventDefault(); });
  P.id('dialog').addEventListener('close', function () {
    if (s.pending && C.token()) P.notice('Há uma confirmação pendente. Toque em Nova compra para retomar a mesma tentativa.');
  });
}());
