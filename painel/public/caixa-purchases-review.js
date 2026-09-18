(function () {
  'use strict';
  const P = window.Caixa.purchases, s = P.state;
  P.reviewFields = ['purchased-date', 'freight', 'discount', 'reference', 'payment', 'payment-method', 'paid-date', 'due-date', 'receipt-status', 'received-date', 'notes'];
  P.readReview = function () {
    const data = s.draft.review;
    P.reviewFields.forEach(function (key) { data[key] = P.id(key).value; });
  };
  P.renderPayment = function () {
    const credit = P.id('payment').value === 'pending'; const lot = s.draft.mode === 'lot';
    P.id('paid-fields').hidden = credit; P.id('credit-fields').hidden = !credit;
    P.id('credit-note').hidden = s.credit;
    P.id('payment').querySelector('[value=pending]').disabled = !s.credit;
    P.id('due-date').parentElement.hidden = !lot && s.draft.installments.length > 0;
    P.id('add-installment').hidden = lot; P.id('installments').hidden = lot;
    P.id('lot-credit-note').hidden = !lot;
    const received = P.id('receipt-status').value === 'received';
    P.id('received-date-label').hidden = !lot || !received;
    P.id('receipt-note').textContent = received
      ? lot ? 'O lote entrará no estoque para triagem ao registrar a compra.' : 'Os pneus entrarão no estoque ao registrar a compra.'
      : 'A entrada no estoque acontece ao conferir a chegada.';
  };
  P.reviewLine = function (label, value) {
    const line = P.el('div', 'pc-review-line'); line.append(P.el('span', '', label), P.el('strong', '', value)); return line;
  };
  P.renderReview = function () {
    P.reviewFields.forEach(function (key) { P.id(key).value = s.draft.review[key] ?? ''; });
    ['purchased-date', 'paid-date', 'received-date'].forEach(function (key) { P.id(key).max = P.today(); });
    const host = P.id('review-items'); host.replaceChildren(P.el('h3', '', P.supplierName()));
    if (s.draft.mode === 'lot') host.append(P.reviewLine(s.draft.lot.quantity + ' pneus · ' + s.draft.lot.description, P.money(s.draft.lot.total_cost)));
    else s.draft.items.forEach(function (item) {
      host.append(P.reviewLine(item.quantity + ' × ' + item.measure + ' · ' + item.brand + ' · ' + P.condition(item.tire_condition), P.money(item.quantity * item.unit_cost)));
    });
    P.renderInstallments(); P.renderPayment();
  };
  P.renderInstallments = function () {
    const host = P.id('installments'); host.replaceChildren();
    s.draft.installments.forEach(function (item, index) {
      const row = P.el('div', 'pc-installment');
      const dateLabel = P.el('label', '', 'Parcela ' + (index + 1)); const date = P.el('input'); date.type = 'date'; date.value = item.due_date;
      date.setAttribute('aria-label', 'Vencimento da parcela ' + (index + 1));
      date.addEventListener('input', function () { item.due_date = date.value; P.changed(); }); dateLabel.append(date);
      const valueLabel = P.el('label', '', 'Valor (R$)'); const value = P.el('input'); value.type = 'number'; value.inputMode = 'decimal'; value.min = '0.01'; value.step = '0.01'; value.value = item.amount;
      value.setAttribute('aria-label', 'Valor da parcela ' + (index + 1));
      value.addEventListener('input', function () { item.amount = value.value === '' ? '' : Number(value.value); P.changed(); }); valueLabel.append(value);
      const remove = P.button('×', function () { s.draft.installments.splice(index, 1); P.changed(); P.renderInstallments(); P.renderPayment(); }, 'pc-button');
      remove.setAttribute('aria-label', 'Remover parcela ' + (index + 1)); row.append(dateLabel, valueLabel, remove); host.append(row);
    });
    P.id('add-installment').textContent = s.draft.installments.length ? '＋ Adicionar parcela' : '＋ Dividir em parcelas';
  };
  function instant(date) { return date ? date + 'T12:00:00-03:00' : undefined; }
  P.payload = function () {
    const d = s.draft, r = d.review;
    const payload = { idempotency_key: d.key, purchased_at: instant(r['purchased-date']),
      freight_amount: Number(r.freight), discount_amount: Number(r.discount),
      payment_status: r.payment, receipt_status: r['receipt-status'] };
    if (d.newSupplier) payload.new_supplier = { name: d.supplierName.trim(), phone: d.supplierPhone.trim() || null, document: d.supplierDocument.trim() || null };
    else payload.supplier_id = d.supplier;
    if (r.reference.trim()) payload.supplier_reference = r.reference.trim();
    if (r.notes.trim()) payload.notes = r.notes.trim();
    if (r.payment === 'paid') { payload.payment_method = r['payment-method']; payload.paid_at = instant(r['paid-date']); }
    else if (d.mode === 'items' && d.installments.length) {
      payload.installments = d.installments.map(function (i) { return { due_date: i.due_date, amount: i.amount === '' ? null : Number(i.amount) }; });
    } else payload.due_date = r['due-date'];
    if (d.mode === 'lot') {
      payload.lot = { ...d.lot, quantity: Number(d.lot.quantity), total_cost: Number(d.lot.total_cost) };
      if (payload.receipt_status === 'received') payload.received_at = instant(r['received-date']);
    } else payload.items = d.items.map(function (i) { return { ...i, quantity: Number(i.quantity), unit_cost: i.unit_cost === '' ? null : Number(i.unit_cost) }; });
    return payload;
  };
  P.verify = async function () {
    P.readReview(); P.persist();
    if (s.draft.review.payment === 'paid' && !s.draft.review['paid-date']) throw Object.assign(new Error('payment_details_required'), { status: 400 });
    const body = P.payload(); const fingerprint = JSON.stringify(body); const suffix = s.draft.mode === 'lot' ? '/lotes' : '';
    const values = await P.request(suffix + '/revisao', body);
    if (!['productsCents', 'freightCents', 'discountCents', 'totalCents'].every(function (key) { return Number.isSafeInteger(values[key]) && values[key] >= 0; })) throw new Error('invalid_response');
    if (!s.draft || JSON.stringify(P.payload()) !== fingerprint) return;
    s.preview = { body: body, suffix: suffix, values: values };
    const host = P.id('verified'); host.hidden = false;
    host.replaceChildren(P.el('h3', '', 'Valores conferidos'), P.reviewLine('Produtos', P.money(values.productsCents / 100)),
      P.reviewLine('Frete', P.money(values.freightCents / 100)), P.reviewLine('Desconto', '− ' + P.money(values.discountCents / 100)), P.reviewLine('Total da compra', P.money(values.totalCents / 100)));
    P.totals(); P.footer(); host.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  P.reviewFields.forEach(function (key) {
    P.id(key).addEventListener('input', function () { if (!s.draft) return; P.readReview(); P.changed(); P.renderPayment(); P.totals(); });
  });
  P.id('add-installment').addEventListener('click', function () {
    if (s.draft.installments.length >= 60) return;
    if (!s.draft.installments.length) s.draft.installments.push({ due_date: P.id('due-date').value, amount: '' });
    s.draft.installments.push({ due_date: '', amount: '' }); P.changed(); P.renderInstallments(); P.renderPayment();
  });
}());
