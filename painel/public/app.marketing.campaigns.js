// Marketing / Campanhas: leitura multicanal; produção nunca inventa canal desconectado.
// O mock demonstra os filtros, mas mantém vendas, lucro e estoque bloqueados.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};

function marketingCampaignMockRows() {
  const base = {
    status: 'with_delivery', attributed_sales: null, profit: null,
    stock_status: 'not_reconciled', attribution_status: 'disabled',
  };
  return [
    { ...base, id: 'meta:1', platform_id: '1', channel: 'meta', name: '205/55 R16 • Curitiba',
      investment: 3245, conversations: 48, cost_per_conversation: 67.6, delivery_days: 25,
      last_delivery: '2026-07-22', decision: { id: 'monitor', label: 'Monitorar', detail: 'Entrega confirmada; verba aguarda atribuição.', tone: 'safe' } },
    { ...base, id: 'meta:2', platform_id: '2', channel: 'meta', name: 'Pneus para moto • Sul',
      investment: 2730, conversations: 56, cost_per_conversation: 48.75, delivery_days: 28,
      last_delivery: '2026-07-22', decision: { id: 'monitor', label: 'Monitorar', detail: 'Entrega confirmada; verba aguarda atribuição.', tone: 'safe' } },
    { ...base, id: 'meta:3', platform_id: '3', channel: 'meta', name: 'Remarketing • Carrinho',
      investment: 1890, conversations: 17, cost_per_conversation: 111.18, delivery_days: 21,
      last_delivery: '2026-07-22', decision: { id: 'review', label: 'Revisar custo', detail: 'Custo acima da média do canal.', tone: 'attention' } },
    { ...base, id: 'google:1', platform_id: 'g1', channel: 'google', name: 'Busca 195/60 R15',
      investment: 2215, conversations: 41, cost_per_conversation: 54.02, delivery_days: 24,
      last_delivery: '2026-07-22', decision: { id: 'monitor', label: 'Monitorar', detail: 'Entrega confirmada; verba aguarda atribuição.', tone: 'safe' } },
    { ...base, id: 'google:2', platform_id: 'g2', channel: 'google', name: 'Pneu perto de mim • RJ',
      investment: 1530, conversations: 0, cost_per_conversation: null, delivery_days: 12,
      last_delivery: '2026-07-21', decision: { id: 'review', label: 'Revisar entrega', detail: 'Investimento sem conversa registrada.', tone: 'attention' } },
    { ...base, id: 'tiktok:1', platform_id: 't1', channel: 'tiktok', name: 'Descoberta • Pneus urbanos',
      investment: 1233, conversations: 22, cost_per_conversation: 56.05, delivery_days: 18,
      last_delivery: '2026-07-22', decision: { id: 'monitor', label: 'Monitorar', detail: 'Entrega confirmada; verba aguarda atribuição.', tone: 'safe' } },
  ];
}

function marketingCampaignMockPayload(channel, period = '30d') {
  const rows = marketingCampaignMockRows().filter((row) => channel === 'all' || row.channel === channel);
  const investment = rows.reduce((total, row) => total + row.investment, 0);
  const conversations = rows.reduce((total, row) => total + row.conversations, 0);
  const reviews = rows.filter((row) => row.decision.id === 'review').length;
  const isSevenDays = period === '7d';
  return {
    environment: 'test', generated_at: '2026-07-22T12:00:00.000Z',
    period: { id: period, days: isSevenDays ? 7 : 30, since: isSevenDays ? '2026-07-16' : '2026-06-24', until: '2026-07-22' },
    selected_channel: channel, connected_channels: ['meta', 'google', 'tiktok'],
    channels: [
      { id: 'meta', label: 'Meta', status: 'connected' },
      { id: 'google', label: 'Google', status: 'connected' },
      { id: 'tiktok', label: 'TikTok', status: 'connected' },
    ],
    metrics: {
      investment, campaigns: rows.length, conversations,
      cost_per_conversation: conversations ? investment / conversations : null,
      attributed_sales: null, profit: null,
    },
    campaigns: rows,
    alerts: [
      ...(reviews ? [{ id: 'review', severity: 'attention', title: `${reviews} campanha(s) precisam de revisão`,
        detail: 'A recomendação usa somente entrega e custo por conversa.', target: 'campanhas' }] : []),
      { id: 'attribution', severity: 'info', title: 'Decisão de verba permanece protegida',
        detail: 'Vendas e lucro aguardam atribuição determinística.', target: 'jornadas' },
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
          detail: available ? 'confirmado nas plataformas' : 'canal sem coleta' },
        { id: 'campaigns', label: 'Com entrega', value: metrics.campaigns ?? '—', icon: 'megaphone',
          detail: available ? 'campanhas no período' : 'canal sem coleta' },
        { id: 'conversations', label: 'Conversas', value: metrics.conversations ?? '—', icon: 'messages-square',
          detail: available ? 'iniciadas por anúncio' : 'canal sem coleta' },
        { id: 'cost', label: 'Custo por conversa', value: money(metrics.cost_per_conversation), icon: 'badge-dollar-sign',
          detail: available ? 'investimento ÷ conversas' : 'canal sem coleta' },
      ];
    },

    marketingCampaignSelectedStatus() {
      if (this.marketingIsMock()) return 'amostra navegável';
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
