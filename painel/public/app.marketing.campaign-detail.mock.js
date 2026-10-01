// Marketing / detalhe da campanha: abre a campanha selecionada sem perder os filtros da lista.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};

function marketingCampaignDetailMock(row, period) {
  const conversations = Number(row?.conversations || 0);
  const replies = Math.round(conversations * 0.727);
  const investment = Number(row?.investment || 0);
  const sales = Number(row?.attributed_sales || 0);
  const revenue = Number(row?.attributed_revenue || 0);
  const margin = Number(row?.gross_margin || 0);
  const metric = (factor, date) => ({
    date, investment: investment * factor, conversations_started: Math.round(conversations * factor),
    first_replies: Math.round(replies * factor),
  });
  return {
    environment: 'test',
    period: { id: period, since: period === '7d' ? '2026-07-19' : '2026-06-27', until: '2026-07-25' },
    campaign: {
      id: row?.platform_id || '1', name: row?.name || 'Campanha Meta',
      channel: 'meta', scope: 'matrix', status: 'with_delivery', currency: 'BRL',
      delivery_days: row?.delivery_days || 1, last_delivery: row?.last_delivery || '2026-07-25',
    },
    summary: {
      investment, financial_investment: investment, impressions: Number(row?.impressions || 0), clicks: Number(row?.clicks || 0),
      link_clicks: Math.round(Number(row?.clicks || 0) * 0.42), video_views: 3560,
      post_engagements: 4140, conversations_started: conversations, first_replies: replies,
      unanswered: Math.max(0, conversations - replies),
      ctr: row?.ctr ?? null,
      cpc: row?.clicks ? investment / Number(row.clicks) : null,
      cpm: row?.impressions ? investment / Number(row.impressions) * 1000 : null,
      response_rate: conversations ? replies / conversations * 100 : null,
      cost_per_started: conversations ? investment / conversations : null,
      cost_per_replied: replies ? investment / replies : null,
      unanswered_investment: conversations ? investment * ((conversations - replies) / conversations) : null,
    },
    trend: [
      metric(0.18, '2026-07-21'), metric(0.26, '2026-07-22'),
      metric(0.31, '2026-07-23'), metric(0.25, '2026-07-24'),
    ],
    ads: [{
      id: 'ad-1', name: 'Criativo WhatsApp 01', media: { image_url: '/assets/catalog-tire.webp', status: 'ACTIVE', format: 'image' }, adset_name: 'Público local',
      investment, impressions: Number(row?.impressions || 0), clicks: Number(row?.clicks || 0),
      conversations_started: conversations, first_replies: replies,
      response_rate: conversations ? replies / conversations * 100 : null,
      cost_per_replied: replies ? investment / replies : null,
      cost_per_started: conversations ? investment / conversations : null,
      attributed_sales: sales, attributed_revenue: revenue, gross_margin: margin,
      net_after_media: margin - investment,
      roas: investment ? revenue / investment : null,
    }],
    conversions: { available: true, enabled: true, sent: Math.max(0, sales - 1), pending: sales ? 1 : 0, failed: 0, suppressed: 0, events: [] },
    attribution: {
      status: 'ready', method: 'last_click_messaging_7d', attributed_sales: sales,
      attributed_revenue: revenue, gross_margin: margin, pending_margin_orders: 0,
    },
    financial: {
      attributed_sales: sales, attributed_revenue: revenue,
      product_cost: Math.max(0, revenue - margin - 650), operation_cost: 650,
      gross_margin: margin, pending_margin_orders: 0,
      net_after_media: margin - investment,
      retained_percent: revenue ? (margin - investment) / revenue * 100 : null,
      roas: investment ? revenue / investment : null,
      cac: sales ? investment / sales : null,
    },
    manager_url: 'https://adsmanager.facebook.com/adsmanager/manage/campaigns',
    tracking: { available: true, ctwa_referrals: 28 },
    quality: {
      conversations_meta: conversations, ctwa_referrals: 28,
      attributed_sales: sales, complete_cost_orders: sales,
      conversion_rate: sales ? sales / 28 * 100 : null,
    },
    orders_total: sales,
    orders: [
      { order_number: 'PED-10482', realized_at: '2026-07-24T14:32:00.000Z', origin: 'WhatsApp',
        revenue: 890, gross_margin: 312, time_to_sale_minutes: 138, status: 'confirmed' },
      { order_number: 'PED-10471', realized_at: '2026-07-23T10:08:00.000Z', origin: 'WhatsApp',
        revenue: 1240, gross_margin: 405, time_to_sale_minutes: 1122, status: 'confirmed' },
      { order_number: 'PED-10455', realized_at: '2026-07-21T16:51:00.000Z', origin: 'WhatsApp',
        revenue: 650, gross_margin: 208, time_to_sale_minutes: 4320, status: 'confirmed' },
    ],
    decision: {
      tone: 'attention', title: 'Há espaço para recuperar conversas sem resposta',
      detail: 'Antes de ampliar a verba, verifique fila, escala e horário de atendimento.',
    },
  };
}
