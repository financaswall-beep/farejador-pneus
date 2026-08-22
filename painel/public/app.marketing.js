// Marketing da matriz: visão executiva + encanamento do endpoint owner-only.
// Dados reais vêm de /admin/api/marketing/overview; ?mock=1 usa amostra rotulada.
// Módulo-fábrica sem estado próprio; montagem via getOwnPropertyDescriptors.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};

function marketingMockPayload(period = '30d') {
  const allSeries = [
    { date: '2026-06-24', spend: 18, conversations: 7 },
    { date: '2026-06-27', spend: 22, conversations: 8 },
    { date: '2026-06-30', spend: 20, conversations: 6 },
    { date: '2026-07-03', spend: 24, conversations: 10 },
    { date: '2026-07-06', spend: 26, conversations: 9 },
    { date: '2026-07-09', spend: 23, conversations: 8 },
    { date: '2026-07-12', spend: 25, conversations: 11 },
    { date: '2026-07-15', spend: 21, conversations: 7 },
    { date: '2026-07-18', spend: 29, conversations: 12 },
    { date: '2026-07-22', spend: 24.99, conversations: 8 },
  ];
  const series = period === '7d' ? allSeries.slice(-3) : allSeries;
  const investment = Math.round(series.reduce((sum, row) => sum + row.spend, 0) * 100) / 100;
  const conversations = series.reduce((sum, row) => sum + row.conversations, 0);
  return {
    environment: 'test',
    generated_at: '2026-07-22T12:00:00.000Z',
    period: {
      id: period,
      days: period === '7d' ? 7 : 30,
      since: period === '7d' ? '2026-07-16' : '2026-06-24',
      until: '2026-07-22',
    },
    connection: { meta: 'connected', attribution: 'enabled', capi: 'disabled' },
    metrics: {
      investment, campaigns: 4, conversations,
      impressions: 18420, clicks: 612, ctr: 3.32,
      cost_per_conversation: conversations ? Math.round((investment / conversations) * 100) / 100 : null,
      attributed_sales: 7, attributed_revenue: 5840,
      gross_margin: 1420, net_after_media: 1187.01, profit: 1187.01,
      pending_margin_orders: 1,
    },
    series,
    comparison: {
      available: false, previous: null, spend_delta_percent: null,
      conversations_delta_percent: null, reason: 'historico_anterior_insuficiente',
    },
    attribution: { available: true, referrals: 0, tracked: 0, ctwa: 0, messenger: 0, instagram: 0 },
    alerts: [
      { id: 'attribution', severity: 'high', title: 'Atribuição incompleta',
        detail: '86 conversas sem venda vinculada', target: 'jornadas' },
      { id: 'ctwa', severity: 'high', title: 'Referência de anúncio ausente',
        detail: 'Nenhuma origem rastreável capturada', target: 'jornadas' },
      { id: 'capi', severity: 'attention', title: 'CAPI não configurada',
        detail: 'Retorno às plataformas bloqueado', target: 'integracoes' },
      { id: 'channels', severity: 'info', title: '2 canais desconectados',
        detail: 'Google e TikTok aguardando conexão', target: 'integracoes' },
    ],
    channels: [
      { id: 'meta', label: 'Meta', status: 'connected' },
      { id: 'google', label: 'Google', status: 'not_connected' },
      { id: 'tiktok', label: 'TikTok', status: 'planned' },
    ],
    quality: [
      { id: 'campaigns', label: 'Campanhas', status: 'ok' },
      { id: 'investment', label: 'Investimento', status: 'ok' },
      { id: 'conversations', label: 'Conversas', status: 'ok' },
      { id: 'attribution', label: 'Atribuição', status: 'pending' },
      { id: 'profit', label: 'Lucro', status: 'blocked' },
    ],
  };
}

window.PAINEL_MODULES.marketing = function () {
  return {
    marketingIsMock() {
      return new URLSearchParams(location.search).get('mock') === '1';
    },

    async loadMarketing() {
      const requestedPeriod = this.marketingPeriod;
      const requestSeq = ++this.marketingRequestSeq;
      this.marketingLoading = true;
      this.marketingError = null;
      try {
        const payload = this.marketingIsMock()
          ? marketingMockPayload(requestedPeriod)
          : await this.apiGet(`/admin/api/marketing/overview?period=${encodeURIComponent(requestedPeriod)}`);
        if (requestSeq === this.marketingRequestSeq && this.marketingPeriod === requestedPeriod) {
          this.marketingVisao = payload;
        }
      } catch {
        if (requestSeq === this.marketingRequestSeq && this.marketingPeriod === requestedPeriod) {
          this.marketingError = 'Não foi possível carregar o Marketing agora.';
        }
      } finally {
        if (requestSeq === this.marketingRequestSeq) {
          this.marketingLoading = false;
          this.$nextTick(() => {
            lucide.createIcons();
            this.renderMarketingChart();
          });
        }
      }
    },

    marketingTabs() {
      return [
        { id: 'visao', label: 'Visão geral' },
        { id: 'campanhas', label: 'Campanhas' },
        { id: 'criativos', label: 'Criativos' },
        { id: 'jornadas', label: 'Jornadas' },
        { id: 'geografia', label: 'Geografia e demanda' },
        { id: 'integracoes', label: 'Integrações' },
      ];
    },

    marketingSetTab(tab) {
      if (tab === 'campanhas' && this.marketingCampaignDetailId) {
        this.closeMarketingCampaignDetail();
      }
      this.marketingTab = tab;
      if (tab === 'campanhas') void this.loadMarketingCampaigns();
      if (tab === 'jornadas') void this.loadMarketingJourneys();
      if (tab === 'integracoes') void this.loadMarketingIntegrations();
      this.$nextTick(() => {
        lucide.createIcons();
        if (tab === 'visao') this.renderMarketingChart();
      });
    },

    marketingPeriodChanged() {
      void this.loadMarketing();
      if (this.marketingTab === 'campanhas') {
        const openedCampaign = this.marketingCampaignDetailId;
        this.marketingCampaigns = null;
        if (openedCampaign) this.marketingCampaignDetail = null;
        void this.loadMarketingCampaigns().then(() => {
          if (openedCampaign && this.marketingCampaignDetailId === openedCampaign) {
            void this.loadMarketingCampaignDetail();
          }
        });
      }
      if (this.marketingTab === 'jornadas') {
        this.marketingJourneys = null;
        void this.loadMarketingJourneys();
      }
      if (this.marketingTab === 'integracoes') {
        this.marketingIntegrations = null;
        void this.loadMarketingIntegrations();
      }
    },

    marketingTabLabel() {
      return this.marketingTabs().find((tab) => tab.id === this.marketingTab)?.label || 'Marketing';
    },

    marketingNavigate(target) {
      this.marketingSetTab(target || 'visao');
      document.querySelector('main')?.scrollTo({ top: 0, behavior: 'smooth' });
    },

    marketingKpis() {
      const metrics = this.marketingVisao?.metrics || {};
      const money = (value) => value == null ? '—' : this.formatCurrency(Number(value));
      return [
        { id: 'investment', label: 'Investimento', value: money(metrics.investment),
          detail: metrics.investment == null ? 'Meta ainda não conectada' : 'Meta API', icon: 'circle-dollar-sign' },
        { id: 'campaigns', label: 'Campanhas no período', value: metrics.campaigns ?? '—',
          detail: metrics.campaigns == null ? 'Aguardando conexão' : 'com entrega', icon: 'megaphone' },
        { id: 'impressions', label: 'Impressões', value: metrics.impressions == null ? '—' : Number(metrics.impressions).toLocaleString('pt-BR'),
          detail: 'Meta API', icon: 'eye' },
        { id: 'clicks', label: 'Cliques', value: metrics.clicks == null ? '—' : Number(metrics.clicks).toLocaleString('pt-BR'),
          detail: metrics.ctr == null ? 'CTR indisponível' : `CTR ${Number(metrics.ctr).toLocaleString('pt-BR')}%`, icon: 'mouse-pointer-click' },
        { id: 'conversations', label: 'Conversas', value: metrics.conversations ?? '—',
          detail: metrics.conversations == null ? 'Aguardando conexão' : 'iniciadas pelo anúncio', icon: 'messages-square' },
        { id: 'cost', label: 'Custo por conversa', value: money(metrics.cost_per_conversation),
          detail: 'investimento ÷ conversas', icon: 'badge-dollar-sign' },
        { id: 'sales', label: 'Vendas atribuídas', value: metrics.attributed_sales ?? '—',
          detail: metrics.attributed_sales == null ? 'atribuição desligada' : 'last-click de mensagem, 7 dias', icon: 'shopping-cart', tone: 'attention' },
        { id: 'profit', label: 'Margem após mídia', value: metrics.net_after_media == null ? 'Não calculada' : money(metrics.net_after_media),
          detail: metrics.pending_margin_orders ? `${metrics.pending_margin_orders} pedido(s) sem custo` : 'margem bruta − mídia', icon: 'trending-up' },
      ];
    },

    marketingDateLabel(date) {
      if (!date) return '—';
      return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', timeZone: 'UTC' })
        .format(new Date(`${date}T12:00:00Z`)).replace('.', '');
    },

    marketingPeriodLabel() {
      const period = this.marketingVisao?.period;
      return period ? `${this.marketingDateLabel(period.since)} — ${this.marketingDateLabel(period.until)}` : 'Últimos 30 dias';
    },

    marketingAlertClass(severity) {
      if (severity === 'high') return 'border-emerald-300 bg-emerald-100/80 text-emerald-950';
      if (severity === 'attention') return 'border-emerald-200 bg-emerald-50 text-emerald-900';
      return 'border-emerald-100 bg-emerald-50/50 text-emerald-800';
    },

    marketingAlertIcon(severity) {
      return severity === 'high' ? 'triangle-alert' : severity === 'attention' ? 'circle-alert' : 'info';
    },

    marketingChannelStatus(status) {
      const labels = {
        connected: 'conectado', disabled: 'desativado', not_configured: 'não configurado',
        error: 'com falha', not_connected: 'não conectado', planned: 'planejado',
      };
      return labels[status] || status;
    },

    marketingChannelClass(status) {
      if (status === 'connected') return 'bg-emerald-100 text-emerald-800';
      if (status === 'planned') return 'border border-emerald-100 bg-emerald-50 text-emerald-700';
      return 'bg-gray-100 text-gray-600';
    },

    marketingQualityClass(status) {
      if (status === 'ok') return 'bg-emerald-100 text-emerald-800';
      if (status === 'blocked') return 'bg-rose-100 text-rose-700';
      return 'bg-amber-100 text-amber-800';
    },

    marketingQualityReady() {
      const rows = this.marketingVisao?.quality || [];
      return `${rows.filter((row) => row.status === 'ok').length} de ${rows.length} fontes prontas`;
    },

    marketingFunnel() {
      const metrics = this.marketingVisao?.metrics || {};
      const money = (value) => value == null ? '—' : this.formatCurrency(Number(value));
      return [
        { label: 'Investimento', value: money(metrics.investment), detail: 'confirmado na plataforma',
          icon: 'circle-dollar-sign', status: metrics.investment == null ? 'pending' : 'ready' },
        { label: 'Conversas', value: metrics.conversations ?? '—', detail: 'iniciadas pelo anúncio',
          icon: 'messages-square', status: metrics.conversations == null ? 'pending' : 'ready' },
        { label: 'Demanda', value: 'A classificar', detail: 'medida e região procuradas',
          icon: 'search', status: 'pending' },
        { label: 'Vendas atribuídas', value: metrics.attributed_sales ?? 'Pendente', detail: 'exige origem de anúncio validada',
          icon: 'shopping-cart', status: metrics.attributed_sales == null ? 'pending' : 'ready' },
        { label: 'Margem após mídia', value: metrics.net_after_media == null ? 'Bloqueada' : money(metrics.net_after_media), detail: 'margem bruta menos mídia',
          icon: 'trending-up', status: metrics.net_after_media == null ? 'blocked' : 'ready' },
      ];
    },
  };
};
