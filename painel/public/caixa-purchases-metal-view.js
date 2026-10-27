(function () {
  'use strict';
  const C = window.Caixa, P = C.purchases;
  const paths = { back: 'm14 5-7 7 7 7', next: 'm9 5 7 7-7 7', plus: 'M12 4v16M4 12h16',
    box: 'm3 7 9-4 9 4-9 5-9-5Zm0 0v10l9 4 9-4V7M12 12v9', check: 'm5 12 4 4L19 6',
    calendar: 'M4 5h16v16H4V5Zm0 5h16M8 2v6m8-6v6M8 14h2m4 0h2m-8 4h2',
    building: 'M5 22V3h14v19M9 7h1m4 0h1m-6 4h1m4 0h1m-6 4h1m4 0h1M3 22h18',
    filter: 'M3 5h18M6 12h12M9 19h6', refresh: 'M20 5v6h-6M4 19v-6h6M5 8a8 8 0 0 1 13-3l2 3M4 16l2 3a8 8 0 0 0 13-3' };
  const el = P.el;
  function icon(name) { return C.createSvg([{ d: paths[name] || paths.next }]); }
  function button(label, action, primary, symbol) {
    const b = P.button('', action, 'pc-button' + (primary ? ' pc-primary' : ''));
    if (symbol) b.appendChild(icon(symbol)); b.appendChild(el('span', '', label)); return b;
  }
  function plate(title, className) {
    const n = el('section', 'pc-card ' + (className || '')); if (title) n.appendChild(el('h3', '', title)); return n;
  }
  function identity(item) {
    const n = el('div', 'mp-product'), text = el('div');
    text.append(el('strong', '', item.measure || 'Pneu'), el('p', '', [item.brand, P.condition(item.tire_condition), P.prices.vehicle(item.vehicle_type)].filter(Boolean).join(' · ')));
    n.append(P.tire(item), text); return n;
  }
  function row(label, value, className) { const n = P.reviewLine(label, value); if (className) n.classList.add(className); return n; }
  const paymentLabel = value => ({ pix: 'Pix', dinheiro: 'Dinheiro', transferencia: 'Transferência', cartao: 'Cartão', boleto: 'Boleto', outro: 'Outro' })[value] || value;
  function card(data) {
    const box = plate(null, 'mp-purchase-card'), top = el('header', 'mp-card-title'), pictures = el('div', 'mp-thumbnails');
    const measures = new Set((data.items || []).map(item => item.measure)).size;
    const copy = el('div'); copy.append(el('h3', '', data.supplier_name || 'Fornecedor'), el('p', 'pc-muted', P.reference(data) + ' · ' + P.date(data.purchased_at)),
      el('p', '', data.items_count + (Number(data.items_count) === 1 ? ' pneu · ' : ' pneus · ') + (data.purchase_kind === 'lot' ? 'Lote fechado' : measures + (measures === 1 ? ' medida' : ' medidas'))),
      el('strong', 'mp-amount', P.money(data.total_amount)));
    if (data.purchase_kind === 'lot') pictures.appendChild(icon('box')); else (data.items || []).slice(0, 2).forEach(item => pictures.appendChild(P.tire(item)));
    top.append(copy, pictures); box.append(top, P.statuses(data));
    if (data.status !== 'cancelled' && data.payment_status === 'pending' && data.due_date) box.appendChild(el('p', 'pc-due', 'Vencimento: ' + P.day(data.due_date)));
    const open = button('Ver compra', () => P.openDetail(data, false), false, 'next'); open.classList.add('pc-full'); box.appendChild(open); return box;
  }
  function stepper(input, maximum) {
    const host = el('span', 'pc-stepper');
    function change(delta) { if (input.disabled) return; input.value = Math.max(0, Math.min(maximum, Number(input.value || 0) + delta)); input.dispatchEvent(new Event('input', { bubbles: true })); }
    const minus = button('−', () => change(-1)), plus = button('+', () => change(1));
    minus.setAttribute('aria-label', 'Diminuir ' + input.getAttribute('aria-label')); plus.setAttribute('aria-label', 'Aumentar ' + input.getAttribute('aria-label'));
    minus.disabled = plus.disabled = input.disabled; host.append(minus, input, plus); return host;
  }
  function detail(data, receiving, inputs) {
    const host = P.id('detail'), lot = data.purchase_kind === 'lot'; host.replaceChildren();
    P.id('dialog').dataset.purchaseView = receiving ? 'receive' : 'detail';
    const supplier = plate('Fornecedor', 'mp-supplier'); supplier.append(el('strong', '', data.supplier_name), el('p', '', P.reference(data) + ' · ' + P.date(data.purchased_at)), P.statuses(data));
    if (data.supplier_reference) supplier.appendChild(el('p', 'pc-muted', 'Referência: ' + data.supplier_reference)); host.appendChild(supplier);
    if (receiving) { const notice = el('p', 'mp-instruction'); notice.append(icon('box'), document.createTextNode('Conte os pneus que chegaram.')); host.appendChild(notice); }
    const items = plate(receiving ? 'Quantidade que chegou' : 'Pneus da compra', 'mp-receipt-items');
    const count = el('strong', 'mp-amount');
    const updateCount = () => {
      const values = [...inputs.values()]; const valid = values.every(input => input.checkValidity());
      const total = values.reduce((n, input) => n + Number(input.value), 0);
      count.textContent = valid ? total + (total === 1 ? ' pneu na conferência' : ' pneus na conferência') : 'Confira as quantidades';
    };
    (data.items || []).forEach(item => {
      const line = el('article', 'mp-receipt-item');
      if (lot) { const info = el('div', 'mp-product'); info.append(icon('box'), el('strong', '', 'Lote fechado')); line.append(info, el('p', '', (item.ordered_quantity ?? item.quantity) + ' pneus')); }
      else line.appendChild(identity(item));
      const ordered = Number(item.ordered_quantity ?? item.quantity), accepted = item.accepted_quantity ?? item.quantity;
      if (receiving && !lot) {
        const input = inputs.get(item.id), label = el('label', 'mp-received', 'Recebidos');
        label.appendChild(stepper(input, ordered)); input.addEventListener('input', updateCount);
        line.append(el('p', 'pc-muted', ordered + (ordered === 1 ? ' pedido' : ' pedidos')), label);
      } else line.append(row(accepted + (lot ? ' pneus' : ' × ' + P.money(item.unit_cost)), P.money(lot ? item.line_total : Number(accepted) * Number(item.unit_cost))));
      items.appendChild(line);
    }); host.appendChild(items);
    const values = plate(receiving ? 'Resumo da conferência' : 'Valores', 'mp-values');
    if (receiving && !lot) { updateCount(); values.appendChild(count); }
    values.append(row('Produtos', P.money(data.products_amount)), row('Frete', P.money(data.freight_amount)), row('Desconto', '− ' + P.money(data.discount_amount)),
      row(receiving ? 'Total registrado' : 'Total', P.money(data.total_amount), 'mp-total-line')); host.appendChild(values);
    const payment = plate('Pagamento', 'mp-payment');
    if (data.status === 'cancelled') payment.appendChild(P.badge('Compra cancelada', 'gray'));
    else payment.appendChild(P.badge(data.payment_status === 'paid' ? 'Pago' : 'A prazo', data.payment_status === 'paid' ? 'green' : 'amber'));
    (data.installments || []).forEach(item => payment.appendChild(row('Parcela ' + item.number + ' · ' + P.day(item.due_date), P.money(item.amount))));
    if (!data.installments?.length && data.payment_status === 'pending' && data.due_date) payment.appendChild(row('Vencimento', P.day(data.due_date)));
    if (data.paid_at) payment.appendChild(row('Pago em', P.date(data.paid_at)));
    if (data.payment_method) payment.appendChild(row('Forma', paymentLabel(data.payment_method))); host.appendChild(payment);
    if (receiving) host.appendChild(el('p', 'pc-notice', lot
      ? 'Confirme somente se o lote inteiro chegou. A triagem dos modelos é feita no painel web.'
      : 'Confirme apenas os pneus aceitos. Essa conferência encerra o recebimento. Total, estoque e financeiro serão ajustados pelas quantidades informadas.'));
    else if (data.status === 'pending') host.appendChild(button('Conferir chegada', () => P.openDetail(data, true), true, 'box'));
    if (data.notes) host.appendChild(el('p', 'pc-muted', data.notes));
    if (data.cancel_reason) host.appendChild(el('p', 'pc-notice', 'Cancelamento: ' + data.cancel_reason));
    P.id('dialog').scrollTop = 0;
  }
  P.metalView = { icon, el, button, plate, card, detail, identity, row };
}());
