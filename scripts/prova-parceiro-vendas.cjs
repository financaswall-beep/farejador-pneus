// Dados de Vendas somente para a prévia local. Não acessa banco ou Chatwoot.
function salesFixture(url) {
  const path = url.pathname;
  if (!path.includes('/api/minhas-vendas')) return null;
  const offset = Math.max(-52, Math.min(0, Number(url.searchParams.get('week') || 0)));
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  const start = new Date(today + 'T12:00:00Z');
  start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7 + offset * 7);
  const amounts = [180, 320, 250, 410, 280, 400, 0];
  const counts = [2, 2, 2, 2, 1, 3, 0];
  const items = [3, 2, 3, 2, 1, 5, 0];
  const sales = [];
  const series = amounts.map((revenue, day) => {
    const date = new Date(start); date.setUTCDate(date.getUTCDate() + day);
    const key = date.toISOString().slice(0, 10);
    const count = key > today ? 0 : counts[day];
    const total = count ? revenue : 0;
    let distributed = 0;
    for (let index = 0; index < count; index++) {
      const value = index === count - 1 ? total - distributed : Math.round(total / count * 100) / 100;
      distributed += value;
      sales.push({
        order_id: '77777777-7777-4777-8777-' + key.replace(/-/g, '') + String(index + 1).padStart(4, '0'),
        order_number: 'PED-' + (248 + sales.length), status: 'delivered',
        payment_method: index % 2 ? 'dinheiro' : 'pix', total_amount: Math.round(value * 100) / 100,
        created_at: key + 'T' + (14 + index) + ':30:00-03:00', items_quantity: index === 0 ? items[day] - count + 1 : 1,
        item_summary: index % 2 ? '80/100-14' : '90/90-18', item_kind: 'pneu',
        commission_kind: 'percent', commission_basis: 'revenue', commission_value: 5,
        commission_amount: Math.round(value * 5) / 100, commission_status: 'receivable', seller_name: 'João Meier',
      });
    }
    return { date: key, revenue: total, sales_count: count, items_quantity: count ? items[day] : 0,
      average_ticket: count ? Math.round(total / count * 100) / 100 : 0, commission_amount: total * .05 };
  });
  const detailId = path.split('/minhas-vendas/')[1];
  if (detailId) {
    // O recibo funciona também depois de abrir uma semana anterior.
    const detailUrl = new URL(url); detailUrl.pathname = path.split('/minhas-vendas/')[0] + '/minhas-vendas';
    for (let week = 0; week >= -52; week--) {
      detailUrl.searchParams.set('week', String(week));
      const sale = salesFixture(detailUrl).sales.find(row => row.order_id === detailId);
      if (sale) return { ...sale, items: [{ product_name: 'Pneu ' + sale.item_summary, quantity: 1,
        reference_unit_price: sale.total_amount, unit_price: sale.total_amount,
        discount_amount: 0, line_total: sale.total_amount, image_url: null, vehicle_type: 'motorcycle' }] };
    }
    return null;
  }
  const summary = series.reduce((sum, day) => ({ revenue: sum.revenue + day.revenue, sales_count: sum.sales_count + day.sales_count,
    items_quantity: sum.items_quantity + day.items_quantity, commission_amount: sum.commission_amount + day.commission_amount }),
    { revenue: 0, sales_count: 0, items_quantity: 0, commission_amount: 0 });
  summary.average_ticket = summary.sales_count ? Math.round(summary.revenue / summary.sales_count * 100) / 100 : 0;
  return { week_offset: offset, summary, daily_series: series, sales: sales.reverse() };
}
module.exports = { salesFixture };
