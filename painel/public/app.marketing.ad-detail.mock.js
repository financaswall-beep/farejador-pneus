// Demonstração explícita; não é utilizada nas consultas de produção.
function marketingAdDetailMock(id, period) {
  const report = marketingCreativeMockPayload(period);
  const selected = report.creatives.find(row => row.id === id) || report.creatives[0];
  const ad = { ...selected, id };
  const peers = report.creatives.filter(row => row.campaign_id === ad.campaign_id);
  if (!peers.some(row => row.id === id)) peers[0] = ad;
  const rows = Array.from({ length: ad.attributed_sales || 0 }, (_, index) => ({
    id: `demo-${index}`, order_number: `#${1084 + index}`, realized_at: `${report.period.until}T15:00:00Z`,
    conversation_id: 418 + index, account_id: 1, channel: 'whatsapp',
    revenue: 190, product_cost: 110, operation_cost: 0, gross_margin: 80,
    conversion_status: index === 0 ? 'pending' : 'sent',
  }));
  const spend = peers.reduce((sum, row) => sum + row.investment, 0);
  const conversations = peers.reduce((sum, row) => sum + row.conversations, 0);
  return {
    available: true, environment: 'test', period: report.period, generated_at: report.last_collected, ad, peers,
    campaign: { id: ad.campaign_id, name: ad.campaign_name, cost_per_conversation: spend / conversations },
    financial: { product_cost: ad.attributed_sales == null ? null : ad.attributed_sales * 110,
      operation_cost: ad.attributed_sales == null ? null : 0,
      roas: ad.attributed_revenue == null ? null : ad.attributed_revenue / ad.investment,
      cost_per_sale: ad.attributed_sales ? ad.investment / ad.attributed_sales : null },
    orders: { available: ad.attributed_sales != null, total: rows.length, rows },
    journeys: { available: true, rows: rows.map(row => ({ conversation_id: row.conversation_id,
      captured_at: row.realized_at, channels: ['whatsapp'], sales: 1, revenue: row.revenue })) },
    conversions: { available: true, enabled: true, sent: Math.max(0, rows.length - 1), pending: rows.length ? 1 : 0,
      failed: 0, suppressed: 0, events: rows.map(row => ({ id: row.id, order_number: row.order_number,
        status: row.conversion_status, attempts: 1, updated_at: row.realized_at, sent_at: row.conversion_status === 'sent' ? row.realized_at : null })) },
    chatwoot_base: null,
  };
}
