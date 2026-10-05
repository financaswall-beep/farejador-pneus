(function () {
  'use strict';
  const C = window.Caixa;
  const U = C.partnerUI;
  const modal = C.elements.receiptModal;
  const parent = modal.parentNode;
  const next = modal.nextSibling;
  const panel = document.getElementById('partner-home-panel');
  const back = document.getElementById('partner-receipt-back');
  const print = document.getElementById('receipt-print');
  let mounted = false;
  let previousFocus = null;

  // Usa o mesmo recibo e a mesma consulta; muda somente a apresentação do parceiro.
  function open() {
    if (!C.isPartner() || mounted) return;
    previousFocus = document.activeElement;
    mounted = true;
    modal.classList.add('pr-detail');
    modal.setAttribute('role', 'region');
    modal.removeAttribute('aria-modal');
    panel.appendChild(modal);
    print.disabled = true;
    modal.classList.remove('hidden');
    back.focus?.({ preventScroll: true });
  }
  function close() {
    if (!mounted) return;
    parent.insertBefore(modal, next);
    modal.classList.remove('pr-detail');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    print.disabled = false;
    mounted = false;
    if (previousFocus?.isConnected) previousFocus.focus?.({ preventScroll: true });
    previousFocus = null;
  }
  function field(label, value) {
    const el = U.node('div', null, 'pr-field');
    el.append(U.node('small', label), U.node('strong', value));
    return el;
  }
  function statusBadge(status) {
    const info = C.statusInfo(status);
    const el = U.node('span', null, 'pr-status pr-status--' + info.className);
    if (info.className === 'done') el.appendChild(U.icon('check'));
    el.appendChild(U.node('span', info.label));
    return el;
  }
  function itemCard(item) {
    const el = U.node('div', null, 'pr-item');
    const image = document.createElement('img');
    image.src = item.image_url || (item.vehicle_type === 'car' ? '/operacao/catalog-tire-car.png' : '/operacao/catalog-tire.webp');
    image.alt = '';
    const product = String(item.product_name || 'Item');
    const measure = product.match(/\b\d{2,3}\s*\/\s*\d{2,3}\s*(?:-|R)\s*\d{2}\b/i);
    const copy = U.node('span', null, 'pr-item-copy');
    copy.appendChild(U.node('b', measure ? measure[0] : product));
    const description = measure ? product.replace(measure[0], '').replace(/^pneu\b/i, '').trim() : '';
    if (description) copy.appendChild(U.node('small', description));
    const tire = measure || ['car', 'motorcycle'].includes(item.vehicle_type);
    const quantity = Number(item.quantity || 0);
    copy.appendChild(U.node('small', quantity + (tire ? quantity === 1 ? ' pneu' : ' pneus' : quantity === 1 ? ' item' : ' itens'), 'pr-item-quantity'));
    const sold = Number(item.unit_price || 0);
    const reference = Number(item.reference_unit_price ?? sold);
    // Só conserva a linha de preços quando houve negociação, sem repetir o valor normal.
    if (Math.abs(reference - sold) >= .005) {
      copy.appendChild(U.node('small', 'Oficial ' + C.currency.format(reference) + ' · negociado ' + C.currency.format(sold) + ' cada', 'pr-item-price-note'));
    }
    el.append(image, copy, U.node('strong', C.currency.format(Number(item.line_total || 0)), 'pr-recessed'));
    ['tl', 'tr', 'bl', 'br'].forEach(corner => {
      const screw = U.node('i', null, 'pr-screw pr-screw--' + corner);
      screw.setAttribute('aria-hidden', 'true'); el.appendChild(screw);
    });
    return el;
  }
  function commission(receipt, labels) {
    const el = U.node('section', null, 'pr-commission');
    const heading = U.node('h3', 'Minha comissão');
    const amount = U.node('strong', 'Você ganhou ' + C.currency.format(Number(receipt.commission_amount || 0)));
    const rule = U.node('span', labels.commissionRule(receipt));
    const badge = U.node('span', null, 'pr-commission-status');
    badge.dataset.status = receipt.commission_status || 'receivable';
    const paid = receipt.commission_status === 'paid';
    const reversed = receipt.commission_status === 'reversed';
    badge.append(C.createSvg(paid ? [{ d: 'm5 12 4 4L19 6' }] : reversed
      ? [{ d: 'm6 6 12 12M6 18 18 6' }]
      : [{ tag: 'circle', cx: '12', cy: '12', r: '9' }, { d: 'M12 7v5l4 3' }]),
    U.node('span', labels.commissionStatus(receipt.commission_status)));
    el.append(heading, amount, rule, badge);
    return el;
  }
  function render(receipt, labels) {
    open();
    const content = C.elements.receiptContent;
    content.replaceChildren();
    const overview = U.node('section', null, 'pr-overview');
    const heading = U.node('div', null, 'pr-order-heading');
    heading.append(U.node('strong', 'Pedido ' + labels.orderLabel(receipt.order_number)), statusBadge(receipt.status));
    const meta = U.node('div', null, 'pr-meta');
    meta.append(field('Data', C.dateTime.format(new Date(receipt.created_at)).replace(', ', ' · ')),
      field('Pagamento', labels.paymentLabel(receipt.payment_method)));
    overview.append(heading, meta);
    const items = U.node('div', null, 'receipt-items pr-items');
    (receipt.items || []).forEach(item => items.appendChild(itemCard(item)));
    const total = U.node('div', null, 'receipt-total pr-total');
    total.append(U.node('span', 'Total da venda'), U.node('strong', C.currency.format(Number(receipt.total_amount || 0)), 'pr-recessed'));
    content.append(overview, U.node('h3', 'Itens vendidos', 'pr-items-title'), items, total, commission(receipt, labels),
      U.node('p', receipt.seller_name ? 'Venda registrada para ' + receipt.seller_name : 'Venda registrada nesta loja', 'receipt-seller pr-seller'));
    content.scrollTop = 0;
    print.disabled = false;
  }
  C.partnerReceipt = { open, close, render };
}());
