(function () {
  'use strict';
  const C = window.Caixa, doc = document, modal = C.elements.receiptModal;
  const printer = doc.getElementById('receipt-print');
  const footer = modal.querySelector('.receipt-sheet > footer'), originalFooter = Array.from(footer.childNodes);
  const originalPrinter = Array.from(printer.childNodes, node => node.cloneNode(true));
  let customized = false, printDetails = null, printWasOpen = false;
  function node(tag, text, className) {
    const el = doc.createElement(tag); if (text != null) el.textContent = String(text);
    if (className) el.className = className; return el;
  }
  function money(value) { return value != null && Number.isFinite(Number(value)) ? C.currency.format(Number(value)) : '—'; }
  function field(list, label, value) { const row = node('div'); row.append(node('dt', label + ':'), node('dd', value)); list.appendChild(row); }
  C.resetMatrixCheckoutReceipt = function () {
    if (customized) printer.replaceChildren(...originalPrinter.map(el => el.cloneNode(true)));
    if (customized) footer.replaceChildren(...originalFooter);
    customized = false; modal.classList.remove('matrix-checkout-receipt');
  };
  C.renderMatrixCheckoutReceipt = function (receipt, labels) {
    customized = true; modal.classList.add('matrix-checkout-receipt');
    const content = C.elements.receiptContent; content.replaceChildren();
    const cancelled = receipt.status === 'cancelled';
    const status = node('div', '', 'mc-receipt-status'); status.dataset.status = receipt.status || '';
    const pending = ['open', 'pending', 'reserved'].includes(receipt.status);
    status.append(C.createSvg([{ d: cancelled ? 'm6 6 12 12M6 18 18 6' : 'm5 12 4 4L19 6' }]),
      node('strong', cancelled ? 'Venda cancelada' : pending ? 'Venda em andamento' : 'Venda registrada'));
    const meta = node('section', '', 'mc-receipt-meta');
    const date = new Date(receipt.created_at);
    const order = String(receipt.order_number || '');
    meta.append(node('strong', order.startsWith('PED-') ? order : labels.orderLabel(order)), node('p', Number.isFinite(date.getTime()) ? C.dateTime.format(date) : 'Data não informada'));
    const list = node('dl');
    field(list, 'Cliente', receipt.customer_name || 'Cliente não informado');
    const received = !cancelled && (receipt.payment_status === 'received' || receipt.status === 'paid');
    field(list, 'Pagamento', labels.paymentLabel(receipt.payment_method) + (received ? ' · Recebido' : ''));
    meta.appendChild(list);
    const items = node('section', '', 'mc-receipt-items'), prices = [];
    (receipt.items || []).forEach(item => {
      const row = node('div', '', 'mc-receipt-row'), copy = node('span');
      row.dataset.quantity = String(item.quantity);
      copy.append(node('b', item.quantity + '× ' + item.product_name));
      const unit = money(item.unit_price);
      copy.append(node('small', 'Valor unitário: ' + unit));
      if (item.reference_unit_price != null && Math.abs(Number(item.reference_unit_price) - Number(item.unit_price)) >= .005) {
        copy.append(node('small', 'Preço oficial: ' + money(item.reference_unit_price)));
      }
      prices.push(item.product_name + ': ' + unit + ' por unidade' + (item.reference_unit_price != null ? ' · oficial ' + money(item.reference_unit_price) : ''));
      row.append(copy, node('strong', money(item.line_total))); items.appendChild(row);
    });
    const total = node('div', '', 'mc-receipt-total'); total.append(node('span', 'Total'), node('strong', money(receipt.total_amount))); items.appendChild(total);
    const details = node('details', '', 'mc-receipt-details');
    details.append(node('summary', 'Comissão e origem'), node('p', 'Comissão: ' + money(receipt.commission_amount)),
      node('p', labels.commissionRule(receipt)), node('p', labels.commissionStatus(receipt.commission_status)), node('p', 'Origem: ' + labels.saleOrigin(receipt)));
    details.append(node('p', 'Status: ' + labels.statusInfo(receipt.status).label));
    prices.forEach(price => details.appendChild(node('p', price)));
    if (receipt.seller_name) details.append(node('p', 'Vendedor: ' + receipt.seller_name));
    content.append(status, meta, items, details);
    const fixedTotal = total.cloneNode(true); fixedTotal.classList.add('mc-receipt-fixed-total'); footer.append(fixedTotal, printer, footer.querySelector('.receipt-done'));
    printer.replaceChildren(C.createSvg([{ d: 'M6 9V3h12v6M6 18H4V9h16v9h-2M7 14h10v7H7z' }]), doc.createTextNode('Imprimir recibo'));
  };
  window.addEventListener('beforeprint', function () {
    if (!modal.classList.contains('matrix-checkout-receipt') || modal.classList.contains('hidden')) return;
    printDetails = modal.querySelector('.mc-receipt-details');
    if (printDetails) { printWasOpen = printDetails.open; printDetails.open = true; }
  });
  window.addEventListener('afterprint', function () { if (printDetails) printDetails.open = printWasOpen; printDetails = null; });

  // As janelas existentes preservam teclado, foco e retorno ao controle que as abriu.
  const sheets = ['checkout-customer-modal', 'checkout-review-modal', 'receipt-modal'].map(id => doc.getElementById(id));
  let active = null, previousFocus = null;
  function visibleSheet() {
    if (C.isPartner()) return null;
    return sheets.find(el => !el.classList.contains('hidden') &&
      (el === modal ? el.classList.contains('matrix-checkout-receipt') : C.elements.app.classList.contains('is-matrix-checkout'))) || null;
  }
  function syncFocus() {
    const next = visibleSheet(); if (next === active) return;
    const former = active; active = next; C.elements.sessionView.inert = Boolean(next);
    if (next) {
      if (!former) previousFocus = doc.activeElement;
      if (next.id !== 'checkout-customer-modal') { const heading = next.querySelector('h2'); heading.tabIndex = -1; heading.focus(); }
    } else {
      if (previousFocus?.isConnected && previousFocus.getClientRects().length) previousFocus.focus();
      else if (C.elements.app.classList.contains('is-matrix-checkout')) doc.getElementById('checkout-add-item').focus();
      previousFocus = null;
    }
  }
  const observer = new MutationObserver(syncFocus);
  sheets.forEach(el => observer.observe(el, { attributes: true, attributeFilter: ['class'] }));
  doc.addEventListener('keydown', function (event) {
    const sheet = visibleSheet(); if (!sheet || doc.querySelector('dialog[open]')) return;
    if (event.key === 'Escape' && !C.checkoutRuntime.state.busy) {
      event.preventDefault(); sheet.querySelector('[data-close-customer],[data-close-checkout],[data-close-receipt]')?.click(); return;
    }
    if (event.key !== 'Tab') return;
    const article = sheet.querySelector('article');
    const controls = Array.from(article.querySelectorAll('button,input,select,textarea,a[href],summary,[tabindex="0"]'))
      .filter(el => !el.disabled && el.getClientRects().length);
    if (!controls.length) return;
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && (doc.activeElement === first || !controls.includes(doc.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (doc.activeElement === last || !article.contains(doc.activeElement))) { event.preventDefault(); first.focus(); }
  });
}());
