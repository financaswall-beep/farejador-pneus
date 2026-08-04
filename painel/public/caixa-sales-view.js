(function () {
  'use strict';

  const Caixa = window.Caixa;
  const elements = Caixa.elements;

  function statusInfo(status) {
    if (status === 'cancelled') return { label: 'Cancelada', className: 'cancelled' };
    if (status === 'open' || status === 'pending') return { label: 'Em andamento', className: 'pending' };
    return { label: 'Concluída', className: 'done' };
  }

  function paymentLabel(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return 'Não informado';
    if (normalized.includes('pix')) return 'Pix';
    if (normalized.includes('dinheiro')) return 'Dinheiro';
    if (normalized.includes('cart') || normalized.includes('crédito') || normalized.includes('débito')) return 'Cartão';
    if (normalized === 'a receber') return 'A receber';
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }

  function orderLabel(value) {
    const text = String(value || '');
    if (text.startsWith('#')) return text;
    return '#' + text.replace(/^PED-/i, '');
  }

  function itemSummary(sale) {
    const amount = Number(sale.items_quantity || 0);
    let kind = sale.item_kind || 'item';
    if (amount !== 1) {
      if (kind === 'pneu') kind = 'pneus';
      else if (kind === 'serviço') kind = 'serviços';
      else kind = 'itens';
    }
    return amount + ' ' + kind;
  }

  function setSalesState(state) {
    elements.salesLoading.classList.toggle('hidden', state !== 'loading');
    elements.salesError.classList.toggle('hidden', state !== 'error');
    elements.salesEmpty.classList.toggle('hidden', state !== 'empty');
    elements.salesList.classList.toggle('hidden', state === 'loading' || state === 'error' || state === 'empty');
  }

  function saleIcon(sale) {
    const icon = document.createElement('span');
    icon.className = 'sale-icon';
    if (sale.item_kind === 'pneu') {
      icon.classList.add('sale-icon--tire');
      const tireImage = document.createElement('img');
      tireImage.src = '/caixa/catalog-tire.webp';
      tireImage.alt = '';
      tireImage.loading = 'lazy';
      tireImage.decoding = 'async';
      icon.appendChild(tireImage);
      return icon;
    }
    icon.appendChild(Caixa.createSvg(sale.item_kind === 'serviço' ? [
      { d: 'm14.7 6.3 3-3a5 5 0 0 1-6.4 6.4l-6.6 6.6a2.1 2.1 0 0 0 3 3l6.6-6.6a5 5 0 0 1 6.4-6.4l-3 3-3-3Z' },
    ] : [
      { d: 'M6 8h12l1 12H5L6 8Z' },
      { d: 'M9 9V6a3 3 0 0 1 6 0v3' },
    ]));
    return icon;
  }

  function saleCard(sale) {
    const article = document.createElement('article');
    const status = statusInfo(sale.status);
    article.className = 'sale-card' + (status.className === 'cancelled' ? ' sale-card--cancelled' : '');
    const details = document.createElement('div');
    details.className = 'sale-details';
    const heading = document.createElement('div');
    heading.className = 'sale-card-heading';
    const title = document.createElement('strong');
    title.textContent = orderLabel(sale.order_number) + ' · ' + sale.customer_name;
    const badge = document.createElement('span');
    badge.className = 'sale-status sale-status--' + status.className;
    if (status.className === 'done') badge.appendChild(Caixa.createSvg([{ d: 'm5 12 4 4L19 6' }]));
    badge.appendChild(document.createTextNode(status.label));
    heading.append(title, badge);

    const meta = document.createElement('p');
    meta.appendChild(document.createTextNode(itemSummary(sale) + ' · '));
    const payment = document.createElement('span');
    payment.textContent = paymentLabel(sale.payment_method);
    meta.appendChild(payment);

    const footer = document.createElement('div');
    footer.className = 'sale-card-footer';
    const amount = document.createElement('strong');
    amount.className = 'sale-amount';
    amount.textContent = Caixa.currency.format(Number(sale.total_amount || 0));
    const receiptButton = document.createElement('button');
    receiptButton.type = 'button';
    receiptButton.className = 'receipt-button';
    receiptButton.appendChild(Caixa.createSvg([
      { d: 'M6 3h12v18l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5L6 21V3Z' },
      { d: 'M9 8h6M9 12h6M9 16h4' },
    ]));
    receiptButton.appendChild(document.createTextNode('Ver recibo'));
    receiptButton.addEventListener('click', function () { void Caixa.openReceipt(sale.order_id); });
    footer.append(amount, receiptButton);
    details.append(heading, meta, footer);
    article.append(saleIcon(sale), details);
    return article;
  }

  function renderProfileSummary(summary) {
    elements.profileMetricSales.textContent = String(summary.sales_count || 0);
    elements.profileMetricRevenue.textContent = Caixa.currency.format(Number(summary.revenue || 0));
  }

  function renderSales(payload) {
    const summary = payload.summary || {};
    elements.metricSales.textContent = String(summary.sales_count || 0);
    elements.metricRevenue.textContent = Caixa.currency.format(Number(summary.revenue || 0));
    elements.metricTicket.textContent = Caixa.currency.format(Number(summary.average_ticket || 0));
    if (payload.period === 'today') renderProfileSummary(summary);
    elements.salesList.replaceChildren();
    const sales = Array.isArray(payload.sales) ? payload.sales : [];
    sales.forEach(function (sale) { elements.salesList.appendChild(saleCard(sale)); });
    elements.salesResultCount.textContent = sales.length
      ? sales.length + (sales.length === 1 ? ' resultado' : ' resultados')
      : '';
    setSalesState(sales.length ? 'ready' : 'empty');
  }

  function textBlock(label, value) {
    const block = document.createElement('div');
    const small = document.createElement('small');
    small.textContent = label;
    const strong = document.createElement('strong');
    strong.textContent = value;
    block.append(small, strong);
    return block;
  }

  function renderReceipt(receipt) {
    elements.receiptContent.replaceChildren();
    const meta = document.createElement('div');
    meta.className = 'receipt-meta';
    meta.append(
      textBlock('Venda', orderLabel(receipt.order_number)),
      textBlock('Data', Caixa.dateTime.format(new Date(receipt.created_at))),
      textBlock('Cliente', receipt.customer_name),
      textBlock('Pagamento', paymentLabel(receipt.payment_method)),
      textBlock('Status', statusInfo(receipt.status).label),
    );
    elements.receiptContent.appendChild(meta);

    const itemsTitle = document.createElement('h3');
    itemsTitle.textContent = 'Itens';
    elements.receiptContent.appendChild(itemsTitle);
    const items = document.createElement('div');
    items.className = 'receipt-items';
    (receipt.items || []).forEach(function (item) {
      const row = document.createElement('div');
      const description = document.createElement('span');
      description.textContent = item.quantity + '× ' + item.product_name;
      const value = document.createElement('strong');
      value.textContent = Caixa.currency.format(Number(item.line_total || 0));
      row.append(description, value);
      items.appendChild(row);
    });
    elements.receiptContent.appendChild(items);

    const total = document.createElement('div');
    total.className = 'receipt-total';
    const label = document.createElement('span');
    label.textContent = 'Total da venda';
    const value = document.createElement('strong');
    value.textContent = Caixa.currency.format(Number(receipt.total_amount || 0));
    total.append(label, value);
    elements.receiptContent.appendChild(total);
    if (receipt.seller_name) {
      const seller = document.createElement('p');
      seller.className = 'receipt-seller';
      seller.textContent = 'Atendimento: ' + receipt.seller_name;
      elements.receiptContent.appendChild(seller);
    }
  }

  Object.assign(Caixa, {
    statusInfo: statusInfo,
    setSalesState: setSalesState,
    renderProfileSummary: renderProfileSummary,
    renderSales: renderSales,
    renderReceipt: renderReceipt,
  });
}());
