// Marketing / Campanhas: leitura real da Meta; canais sem conector permanecem desabilitados.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};

function marketingCampaignMockRows() {
  const base = {
    status: 'with_delivery', stock_status: 'not_reconciled', attribution_status: 'ready',
  };
  return [
    { ...base, id: 'meta:1', platform_id: '1', channel: 'meta', name: '205/55 R16 • Curitiba',
      investment: 3245, impressions: 48500, clicks: 1240, ctr: 2.56, conversations: 48, cost_per_conversation: 67.6,
      attributed_sales: 11, attributed_revenue: 12900, gross_margin: 3100, profit: -145, delivery_days: 25,
      last_delivery: '2026-07-22', decision: { id: 'monitor', label: 'Monitorar', detail: 'Entrega confirmada; verba aguarda atribuição.', tone: 'safe' } },
    { ...base, id: 'meta:2', platform_id: '2', channel: 'meta', name: 'Pneus para moto • Sul',
      investment: 2730, impressions: 57200, clicks: 1680, ctr: 2.94, conversations: 56, cost_per_conversation: 48.75,
      attributed_sales: 18, attributed_revenue: 14750, gross_margin: 4420, profit: 1690, delivery_days: 28,
      last_delivery: '2026-07-22', decision: { id: 'monitor', label: 'Monitorar', detail: 'Entrega confirmada; verba aguarda atribuição.', tone: 'safe' } },
    { ...base, id: 'meta:3', platform_id: '3', channel: 'meta', name: 'Remarketing • Carrinho',
      investment: 1890, impressions: 22400, clicks: 430, ctr: 1.92, conversations: 17, cost_per_conversation: 111.18,
      attributed_sales: 2, attributed_revenue: 2100, gross_margin: 510, profit: -1380, delivery_days: 21,
      last_delivery: '2026-07-22', decision: { id: 'review', label: 'Revisar custo', detail: 'Custo acima da média do canal.', tone: 'attention' } },
  ];
}

function marketingCampaignMockPayload(channel, period = '30d') {
  const rows = marketingCampaignMockRows().filter((row) => channel === 'all' || row.channel === channel);
  const investment = rows.reduce((total, row) => total + row.investment, 0);
  const conversations = rows.reduce((total, row) => total + row.conversations, 0);
  const impressions = rows.reduce((total, row) => total + row.impressions, 0);
  const clicks = rows.reduce((total, row) => total + row.clicks, 0);
  const attributedSales = rows.reduce((total, row) => total + row.attributed_sales, 0);
  const attributedRevenue = rows.reduce((total, row) => total + row.attributed_revenue, 0);
  const grossMargin = rows.reduce((total, row) => total + row.gross_margin, 0);
  const reviews = rows.filter((row) => row.decision.id === 'review').length;
  const isSevenDays = period === '7d';
  return {
    environment: 'test', generated_at: '2026-07-22T12:00:00.000Z',
    period: { id: period, days: isSevenDays ? 7 : 30, since: isSevenDays ? '2026-07-16' : '2026-06-24', until: '2026-07-22' },
    selected_channel: channel, connected_channels: ['meta'],
    channels: [
      { id: 'meta', label: 'Meta', status: 'connected' },
      { id: 'google', label: 'Google', status: 'not_connected' },
      { id: 'tiktok', label: 'TikTok', status: 'planned' },
    ],
    metrics: {
      investment, campaigns: rows.length, conversations, impressions, clicks,
      ctr: impressions ? Math.round((clicks / impressions) * 10000) / 100 : null,
      cost_per_conversation: conversations ? investment / conversations : null,
      attributed_sales: attributedSales, attributed_revenue: attributedRevenue,
      gross_margin: grossMargin, net_after_media: grossMargin - investment, profit: grossMargin - investment,
    },
    campaigns: rows,
    alerts: [
      ...(reviews ? [{ id: 'review', severity: 'attention', title: `${reviews} campanha(s) precisam de revisão`,
        detail: 'A recomendação usa somente entrega e custo por conversa.', target: 'campanhas' }] : []),
      { id: 'attribution', severity: 'info', title: 'Atribuição determinística ativa na amostra',
        detail: 'Last-click CTWA em 7 dias, com uma venda por clique.', target: 'jornadas' },
    ],
  };
}

window.PAINEL_MODULES.marketingCampaigns = function () {
  return {
    marketingCampaignChannels() {
      return [
        { id: 'all', label: 'Consolidado' },
        { id: 'meta', label: 'Meta' },
        { id: 'google', label: 'Google' },
        { id: 'tiktok', label: 'TikTok' },
      ];
    },

    async loadMarketingCampaigns() {
      const requestedChannel = this.marketingCampaignChannel;
      const requestSeq = ++this.marketingCampaignRequestSeq;
      this.marketingCampaignsLoading = true;
      this.marketingCampaignsError = null;
      try {
        const payload = this.marketingIsMock()
          ? marketingCampaignMockPayload(requestedChannel, this.marketingPeriod)
          : await this.apiGet(`/admin/api/marketing/campaigns?period=${encodeURIComponent(this.marketingPeriod)}&channel=${encodeURIComponent(requestedChannel)}`);
        if (requestSeq === this.marketingCampaignRequestSeq && this.marketingCampaignChannel === requestedChannel) {
          this.marketingCampaigns = payload;
        }
      } catch {
        if (requestSeq === this.marketingCampaignRequestSeq && this.marketingCampaignChannel === requestedChannel) {
          this.marketingCampaignsError = 'Não foi possível carregar as campanhas agora.';
        }
      } finally {
        if (requestSeq === this.marketingCampaignRequestSeq) {
          this.marketingCampaignsLoading = false;
          this.$nextTick(() => lucide.createIcons());
        }
      }
    },

    marketingCampaignSetChannel(channel) {
      if (this.marketingCampaignChannel === channel && this.marketingCampaigns) return;
      this.marketingCampaignChannel = channel;
      this.marketingCampaignDecision = 'all';
      this.marketingCampaignSearch = '';
      this.marketingCampaignPage = 1;
      void this.loadMarketingCampaigns();
    },

    marketingCampaignSummary() {
      const metrics = this.marketingCampaigns?.metrics || {};
      const money = (value) => value == null ? '—' : this.formatCurrency(Number(value));
      const available = metrics.investment != null;
      return [
        { id: 'investment', label: 'Investimento', value: money(metrics.investment), icon: 'circle-dollar-sign',
          detail: available ? 'confirmado na Meta' : 'canal sem coleta' },
        { id: 'campaigns', label: 'Com entrega', value: metrics.campaigns ?? '—', icon: 'megaphone',
          detail: available ? 'campanhas no período' : 'canal sem coleta' },
        { id: 'impressions', label: 'Impressões', value: metrics.impressions == null ? '—' : Number(metrics.impressions).toLocaleString('pt-BR'), icon: 'eye',
          detail: available ? 'Meta API' : 'canal sem coleta' },
        { id: 'clicks', label: 'Cliques / CTR', value: metrics.clicks == null ? '—' : Number(metrics.clicks).toLocaleString('pt-BR'), icon: 'mouse-pointer-click',
          detail: metrics.ctr == null ? 'CTR indisponível' : `${Number(metrics.ctr).toLocaleString('pt-BR')}%` },
        { id: 'conversations', label: 'Conversas', value: metrics.conversations ?? '—', icon: 'messages-square',
          detail: available ? 'iniciadas por anúncio' : 'canal sem coleta' },
        { id: 'cost', label: 'Custo por conversa', value: money(metrics.cost_per_conversation), icon: 'badge-dollar-sign',
          detail: available ? 'investimento ÷ conversas' : 'canal sem coleta' },
      ];
    },

    marketingCampaignSelectedStatus() {
      if (this.marketingIsMock()) return 'amostra Meta navegável';
      if (this.marketingCampaignChannel === 'all') {
        return `${this.marketingCampaigns?.connected_channels?.length || 0} canal(is) com dados`;
      }
      const selected = this.marketingCampaigns?.channels?.find((row) => row.id === this.marketingCampaignChannel);
      return selected ? this.marketingChannelStatus(selected.status) : 'sem dados';
    },

    marketingCampaignDecisionTabs() {
      return [
        { id: 'all', label: 'Todas' },
        { id: 'review', label: 'Revisar' },
        { id: 'monitor', label: 'Monitorar' },
      ];
    },

    marketingCampaignFiltered() {
      const query = this.marketingCampaignSearch.trim().toLocaleLowerCase('pt-BR');
      return (this.marketingCampaigns?.campaigns || []).filter((row) => {
        const decisionOk = this.marketingCampaignDecision === 'all'
          || row.decision?.id === this.marketingCampaignDecision;
        const searchOk = !query || String(row.name).toLocaleLowerCase('pt-BR').includes(query);
        return decisionOk && searchOk;
      });
    },

    marketingCampaignPageRows() {
      const start = (this.marketingCampaignPage - 1) * 10;
      return this.marketingCampaignFiltered().slice(start, start + 10);
    },

    marketingCampaignPageCount() {
      return Math.max(1, Math.ceil(this.marketingCampaignFiltered().length / 10));
    },

    marketingCampaignSetPage(page) {
      this.marketingCampaignPage = Math.min(Math.max(1, page), this.marketingCampaignPageCount());
    },

    marketingCampaignDecisionClass(decision) {
      return decision?.tone === 'attention'
        ? 'border-amber-200 bg-amber-50 text-amber-800'
        : 'border-emerald-200 bg-emerald-50 text-emerald-800';
    },

    marketingCampaignChannelName(channel) {
      return channel === 'meta' ? 'Meta' : channel === 'google' ? 'Google' : channel === 'tiktok' ? 'TikTok' : 'Consolidado';
    },

    marketingCampaignRecommendations() {
      const rows = this.marketingCampaignFiltered();
      const reviews = rows.filter((row) => row.decision?.id === 'review').slice(0, 2).map((row) => ({
        id: row.id, title: row.decision.label, detail: row.name, target: 'campanhas', icon: 'scan-search',
      }));
      if (this.marketingCampaignChannel === 'google' && !rows.length) {
        reviews.push({ id: 'google', title: 'Conectar Google Ads', detail: 'Liberar coleta individual do canal.', target: 'integracoes', icon: 'plug-zap' });
      }
      if (this.marketingCampaignChannel === 'tiktok' && !rows.length) {
        reviews.push({ id: 'tiktok', title: 'Preparar TikTok Ads', detail: 'Definir credencial e conta antes da coleta.', target: 'integracoes', icon: 'plug-zap' });
      }
      if (['all', 'meta'].includes(this.marketingCampaignChannel) && !rows.length) {
        reviews.push({ id: 'meta', title: 'Conectar Meta Ads', detail: 'Liberar a leitura real das campanhas.', target: 'integracoes', icon: 'plug-zap' });
      }
      reviews.push({ id: 'attribution', title: 'Validar atribuição', detail: 'Liberar vendas, lucro e decisão de verba.', target: 'jornadas', icon: 'route' });
      return reviews.slice(0, 3);
    },

    marketingCampaignAlertClass(severity) {
      if (severity === 'high') return 'bg-amber-50 text-amber-800';
      if (severity === 'attention') return 'bg-emerald-100 text-emerald-900';
      return 'bg-emerald-50 text-emerald-800';
    },
  };
};
