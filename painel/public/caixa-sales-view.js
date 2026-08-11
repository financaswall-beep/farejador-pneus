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

  function commissionStatus(value) {
    if (value === 'paid') return 'Paga';
    if (value === 'reversed') return 'Cancelada';
    return 'A receber';
  }

  function commissionRule(sale) {
    if (!sale.commission_kind || Number(sale.commission_value || 0) <= 0) return 'Sem comissão configurada';
    if (sale.commission_kind === 'fixed') return 'Valor fixo por venda';
    if (sale.commission_basis === 'margin') return sale.commission_value + '% sobre a margem';
    return sale.commission_value + '% sobre ' + Caixa.currency.format(Number(sale.total_amount || 0));
  }

  function setSalesState(value) {
    elements.salesLoading.classList.toggle('hidden', value !== 'loading');
    elements.salesError.classList.toggle('hidden', value !== 'error');
    elements.salesEmpty.classList.toggle('hidden', value !== 'empty');
    elements.salesList.classList.toggle('hidden', ['loading', 'error', 'empty'].includes(value));
  }

  function renderProfileSummary(summary) {
    elements.profileMetricSales.textContent = String(summary.sales_count || 0);
    elements.profileMetricRevenue.textContent = Caixa.currency.format(Number(summary.revenue || 0));
  }

  function saleIcon() {
    const icon = document.createElement('span');
    icon.className = 'sale-icon';
    icon.appendChild(Caixa.createSvg([
      { d: 'M3 4h2l2.4 10.2a2 2 0 0 0 2 1.6h7.8a2 2 0 0 0 2-1.6L21 8H6' },
      { tag: 'circle', cx: '9', cy: '20', r: '1' },
      { tag: 'circle', cx: '18', cy: '20', r: '1' },
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
    title.textContent = 'Pedido ' + orderLabel(sale.order_number);
    const badge = document.createElement('span');
    badge.className = 'sale-status sale-status--' + status.className;
    if (status.className === 'done') badge.appendChild(Caixa.createSvg([{ d: 'm5 12 4 4L19 6' }]));
    badge.appendChild(document.createTextNode(status.label));
    heading.append(title, badge);

    const item = document.createElement('p');
    item.textContent = sale.item_summary || (sale.items_quantity + ' item(ns)');
    const meta = document.createElement('span');
    meta.className = 'sale-payment';
    meta.textContent = paymentLabel(sale.payment_method);
    const amount = document.createElement('strong');
    amount.className = 'sale-amount';
    amount.textContent = Caixa.currency.format(Number(sale.total_amount || 0));

    const commission = document.createElement('div');
    commission.className = 'sale-commission';
    const commissionText = document.createElement('span');
    commissionText.textContent = status.className === 'cancelled'
      ? 'Comissão cancelada'
      : 'Sua comissão: ' + Caixa.currency.format(Number(sale.commission_amount || 0));
    const detailsButton = document.createElement('button');
    detailsButton.type = 'button';
    detailsButton.className = 'receipt-button';
    detailsButton.textContent = 'Ver detalhes';
    detailsButton.addEventListener('click', function () { void Caixa.openReceipt(sale.order_id); });
    commission.append(commissionText, detailsButton);
    details.append(heading, item, meta, amount, commission);
    article.append(saleIcon(), details);
    return article;
  }

  function weeklyDate(value) {
    return new Date(String(value) + 'T12:00:00-03:00');
  }

  function weeklyRangeLabel(series) {
    if (!series.length) return 'Semana atual';
    const first = weeklyDate(series[0].date);
    const last = weeklyDate(series[series.length - 1].date);
    const month = new Intl.DateTimeFormat('pt-BR', { month: 'short' }).format(last).replace('.', '');
    return String(first.getDate()).padStart(2, '0') + '–'
      + String(last.getDate()).padStart(2, '0') + ' ' + month;
  }

  function renderWeeklySummary(payload) {
    const summary = payload.summary || {};
    const series = Array.isArray(payload.daily_series) ? payload.daily_series : [];
    const values = series.map(function (day) { return Number(day.revenue || 0); });
    const max = Math.max(1, ...values);
    const average = series.length ? Number(summary.revenue || 0) / series.length : 0;
    const offset = Number(payload.week_offset || 0);
    elements.weeklySummary.classList.remove('hidden');
    elements.weeklyRange.textContent = weeklyRangeLabel(series);
    elements.weeklyWeekState.textContent = offset === 0 ? 'Semana atual'
      : (offset === -1 ? 'Semana anterior' : Math.abs(offset) + ' semanas atrás');
    elements.weeklyPrev.disabled = offset <= -52;
    elements.weeklyNext.disabled = offset >= 0;
    elements.weeklyTotal.textContent = Caixa.currency.format(Number(summary.revenue || 0));
    elements.weeklySalesCount.textContent = String(summary.sales_count || 0);
    elements.weeklyItemsCount.textContent = String(summary.items_quantity || 0);
    elements.weeklyTicket.textContent = Caixa.currency.format(Number(summary.average_ticket || 0));
    elements.weeklyCommission.textContent = Caixa.currency.format(Number(summary.commission_amount || 0));
    elements.weeklyReference.style.bottom = Math.min(94, average / max * 100) + '%';
    elements.weeklyReferenceValue.textContent = 'média ' + Caixa.currency.format(average);
    elements.weeklyBars.replaceChildren();
    const dayFormat = new Intl.DateTimeFormat('pt-BR', { weekday: 'short' });
    series.forEach(function (day) {
      const date = weeklyDate(day.date);
      const item = document.createElement('div');
      item.className = 'weekly-bar-item' + (Number(day.revenue || 0) === max ? ' is-best' : '');
      const value = document.createElement('span');
      value.className = 'weekly-bar-value';
      value.textContent = Number(day.revenue || 0) ? Number(day.revenue).toFixed(2).replace('.', ',') : '0';
      const bar = document.createElement('i');
      bar.style.height = Math.max(3, Number(day.revenue || 0) / max * 100) + '%';
      const dayName = document.createElement('small');
      dayName.textContent = dayFormat.format(date).replace('.', '');
      const dayNumber = document.createElement('b');
      dayNumber.textContent = String(date.getDate()).padStart(2, '0');
      item.append(value, bar, dayName, dayNumber);
      elements.weeklyBars.appendChild(item);
    });
  }

  function renderSales(payload) {
    renderWeeklySummary(payload);
    elements.salesList.replaceChildren();
    const sales = Array.isArray(payload.sales) ? payload.sales : [];
    sales.forEach(function (sale) { elements.salesList.appendChild(saleCard(sale)); });
    elements.salesResultCount.textContent = sales.length ? sales.length + ' na semana' : '';
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
      textBlock('Pedido', orderLabel(receipt.order_number)),
      textBlock('Data', Caixa.dateTime.format(new Date(receipt.created_at))),
      textBlock('Pagamento', paymentLabel(receipt.payment_method)),
      textBlock('Status', statusInfo(receipt.status).label),
    );
    elements.receiptContent.appendChild(meta);
    const title = document.createElement('h3');
    title.textContent = 'Itens';
    elements.receiptContent.appendChild(title);
    const items = document.createElement('div');
    items.className = 'receipt-items';
    (receipt.items || []).forEach(function (item) {
      const row = document.createElement('div');
      const image = document.createElement('img');
      image.src = item.image_url || '/caixa/catalog-tire.webp';
      image.alt = '';
      const copy = document.createElement('span');
      const name = document.createElement('b');
      name.textContent = item.quantity + '× ' + item.product_name;
      const unit = document.createElement('small');
      unit.textContent = Caixa.currency.format(Number(item.unit_price || 0)) + ' cada';
      copy.append(name, unit);
      const value = document.createElement('strong');
      value.textContent = Caixa.currency.format(Number(item.line_total || 0));
      row.append(image, copy, value);
      items.appendChild(row);
    });
    elements.receiptContent.appendChild(items);
    const total = document.createElement('div');
    total.className = 'receipt-total';
    const totalLabel = document.createElement('span');
    totalLabel.textContent = 'Total da venda';
    const totalValue = document.createElement('strong');
    totalValue.textContent = Caixa.currency.format(Number(receipt.total_amount || 0));
    total.append(totalLabel, totalValue);
    elements.receiptContent.appendChild(total);
    const commission = document.createElement('section');
    commission.className = 'receipt-commission';
    const kicker = document.createElement('small');
    kicker.textContent = 'MINHA COMISSÃO';
    const amount = document.createElement('strong');
    amount.textContent = 'Você ganhou ' + Caixa.currency.format(Number(receipt.commission_amount || 0));
    const rule = document.createElement('span');
    rule.textContent = commissionRule(receipt);
    const status = document.createElement('em');
    status.textContent = commissionStatus(receipt.commission_status);
    commission.append(kicker, amount, rule, status);
    elements.receiptContent.appendChild(commission);
    const seller = document.createElement('p');
    seller.className = 'receipt-seller';
    seller.textContent = 'Venda registrada para ' + receipt.seller_name;
    elements.receiptContent.appendChild(seller);
  }

  Object.assign(Caixa, {
    statusInfo: statusInfo,
    setSalesState: setSalesState,
    renderProfileSummary: renderProfileSummary,
    renderSales: renderSales,
    renderReceipt: renderReceipt,
  });
}());
