// Exclusivo da prévia rotulada ?mock=1. Nenhuma requisição ou persistência.
function marketingCreativeMockPayload(period) {
  const until = new Date().toISOString().slice(0, 10);
  const first = new Date(`${until}T12:00:00Z`); first.setUTCDate(first.getUTCDate() - (period === '7d' ? 6 : 29));
  const since = first.toISOString().slice(0, 10);
  const examples = [
    ['NMAX · Traseiro', 240, 60, 6, 'image', 'catalog-tire.webp'],
    ['Qualidade · Meia-vida', 300, 50, 4, 'video', 'tire-dashboard.webp'],
    ['Retirada · São Gonçalo', 180, 30, 2, 'image', 'estoque-hero-warehouse.webp'],
    ['Pneus novos', 90, 9, null, 'carousel', 'catalog-tire.webp'],
    ['Atendimento na Matriz', 60, 6, 0, 'image', 'estoque-hero.webp'],
    ['Conheça nossa loja', 30, 3, null, 'unknown', null],
  ];
  const creatives = examples.map(([name, investment, conversations, sales, format, asset], i) => ({
    id: String(i + 1), name, campaign_id: i < 3 ? '1' : '2', campaign_name: i < 3 ? 'Pneus para scooter' : 'Pneus da Matriz',
    scope: 'matrix', currency: 'BRL', investment, conversations, impressions: 1800, clicks: 180,
    cost_per_conversation: investment / conversations, tracked: Math.round(conversations * .8), channels: ['whatsapp'],
    attributed_sales: sales, attributed_revenue: sales == null ? null : sales * 190, attribution_status: sales == null ? 'pending' : 'ready',
    meta_url: null, preview_url: null,
    media: { id: String(i + 1), format, status: i === 4 ? 'PAUSED' : 'ACTIVE', image_url: asset ? `/admin/painel/assets/${asset}` : null },
    series: Array.from({ length: period === '7d' ? 7 : 30 }, (_, index) => {
      const date = new Date(`${since}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + index);
      const days = period === '7d' ? 7 : 30;
      const count = Math.floor(conversations / days) + (index < conversations % days ? 1 : 0);
      return { date: date.toISOString().slice(0, 10), spend: investment / days, conversations: count };
    }),
  }));
  return { environment: 'test', available: true, media_status: 'ready', attribution_enabled: true,
    period: { id: period, since, until }, creatives };
}
