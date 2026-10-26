(function () {
  'use strict';
  const C = window.Caixa, doc = document, modal = C.elements.receiptModal;
  const printer = doc.getElementById('receipt-print');
  const footer = modal.querySelector('.receipt-sheet > footer'), originalFooter = Array.from(footer.childNodes);
  const originalPrinter = Array.from(printer.childNodes, node => node.cloneNode(true));
  const title = doc.getElementById('receipt-title'), close = modal.querySelector('.receipt-close');
  const originalTitle = title.textContent, originalCloseLabel = close.getAttribute('aria-label');
  let customized = false, returnToSale = null;
  function node(tag, text, className) {
    const el = doc.createElement(tag); if (text != null) el.textContent = String(text);
    if (className) el.className = className; return el;
  }
  function money(value) { return value != null && Number.isFinite(Number(value)) ? C.currency.format(Number(value)) : '—'; }
  function field(list, label, value) { const row = node('div'); row.append(node('dt', label + ':'), node('dd', value)); list.appendChild(row); }
  C.resetMatrixCheckoutReceipt = function () {
    if (customized) printer.replaceChildren(...originalPrinter.map(el => el.cloneNode(true)));
    if (customized) footer.replaceChildren(...originalFooter);
    title.textContent = originalTitle; close.setAttribute('aria-label', originalCloseLabel);
    returnToSale = null; customized = false;
    modal.classList.remove('matrix-checkout-receipt', 'mc-commission-detail');
  };
  C.renderMatrixCheckoutReceipt = function (receipt, labels) {
    customized = true; modal.classList.add('matrix-checkout-receipt');
    const content = C.elements.receiptContent; content.replaceChildren(); content.scrollTop = 0;
    const overview = node('div', '', 'mc-receipt-overview'), commission = C.matrixSaleCommission;
    const cancelled = receipt.status === 'cancelled';
    const status = node('div', '', 'mc-receipt-status'); status.dataset.status = receipt.status || '';
    const pending = ['open', 'pending', 'reserved'].includes(receipt.status);
    status.append(C.createSvg([{ d: cancelled ? 'm6 6 12 12M6 18 18 6' : 'm5 12 4 4L19 6' }]),
      node('strong', cancelled ? 'Venda cancelada' : pending ? 'Venda em andamento'
        : ['paid', 'delivered'].includes(receipt.status) ? 'Venda concluída' : 'Venda registrada'));
    const meta = node('section', '', 'mc-receipt-meta');
    const date = new Date(receipt.created_at);
    const order = String(receipt.order_number || '');
    const identification = node('div', '', 'mc-receipt-identification');
    identification.append(node('strong', order.startsWith('PED-') ? order : labels.orderLabel(order)), node('p', Number.isFinite(date.getTime()) ? C.dateTime.format(date) : 'Data não informada'));
    meta.append(identification);
    const list = node('dl');
    field(list, 'Cliente', receipt.customer_name || 'Cliente não informado');
    const received = !cancelled && (receipt.payment_status === 'received' || receipt.status === 'paid');
    field(list, 'Pagamento', labels.paymentLabel(receipt.payment_method) + (received ? ' · Recebido' : ''));
    meta.appendChild(list);
    const items = node('section', '', 'mc-receipt-items');
    const itemHeading = node('h3'); itemHeading.append(C.createSvg([{ d: 'M3 3h2l3 12h10l3-9H6M9 21h.01M18 21h.01' }]), node('span', 'Produtos da venda'));
    items.append(itemHeading);
    (receipt.items || []).forEach(item => {
      const row = node('div', '', 'mc-receipt-row'), copy = node('span');
      row.dataset.quantity = String(item.quantity);
      copy.append(node('b', item.quantity + '× ' + item.product_name));
      const unit = money(item.unit_price);
      copy.append(node('small', 'Valor unitário: ' + unit));
      if (item.reference_unit_price != null && Math.abs(Number(item.reference_unit_price) - Number(item.unit_price)) >= .005) {
        copy.append(node('small', 'Preço oficial: ' + money(item.reference_unit_price), 'mc-reference-price'));
      }
      row.append(copy, node('strong', money(item.line_total))); items.appendChild(row);
    });
    const total = node('div', '', 'mc-receipt-total'); total.append(node('span', 'Total da venda'), node('strong', money(receipt.total_amount))); items.appendChild(total);
    const calculation = commission.detail(receipt, labels);
    let savedScroll = 0;
    const summary = commission.summary(receipt, function () {
      savedScroll = content.scrollTop; overview.classList.add('hidden'); calculation.classList.remove('hidden');
      modal.classList.add('mc-commission-detail'); title.textContent = 'Comissão da venda';
      close.setAttribute('aria-label', 'Voltar à venda'); content.scrollTop = 0;
      title.tabIndex = -1; title.focus({ preventScroll: true });
    });
    returnToSale = function () {
      overview.classList.remove('hidden'); calculation.classList.add('hidden'); modal.classList.remove('mc-commission-detail');
      title.textContent = originalTitle; close.setAttribute('aria-label', originalCloseLabel);
      content.scrollTop = savedScroll; summary.querySelector('button').focus({ preventScroll: true });
    };
    overview.append(status, meta, items, commission.originCard(receipt, labels), summary);
    content.append(overview, calculation);
    const back = node('button', '', 'mc-commission-back'); back.type = 'button';
    back.append(commission.icon('back'), node('span', 'Voltar à venda')); back.addEventListener('click', returnToSale);
    footer.append(printer, footer.querySelector('.receipt-done'), back);
    printer.replaceChildren(C.createSvg([{ d: 'M6 9V3h12v6M6 18H4V9h16v9h-2M7 14h10v7H7z' }]), doc.createTextNode('Imprimir recibo'));
  };
  modal.addEventListener('click', function (event) {
    if (!modal.classList.contains('mc-commission-detail') || !event.target.closest('[data-close-receipt]')) return;
    event.preventDefault(); event.stopPropagation(); returnToSale?.();
  }, true);

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
      event.preventDefault(); event.stopImmediatePropagation();
      sheet.querySelector('[data-close-customer],[data-close-checkout],[data-close-receipt]')?.click(); return;
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
