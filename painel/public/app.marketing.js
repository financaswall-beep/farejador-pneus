// Marketing da matriz: visão executiva + encanamento do endpoint owner-only.
// Dados reais vêm de /admin/api/marketing/overview; ?mock=1 usa amostra rotulada.
// Módulo-fábrica sem estado próprio; montagem via getOwnPropertyDescriptors.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};

function marketingMockPayload() {
  return {
    environment: 'test',
    generated_at: '2026-07-22T12:00:00.000Z',
    period: { id: '30d', days: 30, since: '2026-06-24', until: '2026-07-22' },
    connection: { meta: 'connected', attribution: 'disabled', capi: 'not_implemented' },
    metrics: {
      investment: 232.99, campaigns: 4, conversations: 86,
      cost_per_conversation: 2.71, attributed_sales: null, profit: null,
    },
    series: [
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
    ],
    comparison: {
      available: false, previous: null, spend_delta_percent: null,
      conversations_delta_percent: null, reason: 'historico_anterior_insuficiente',
    },
    attribution: { available: true, referrals: 0, ctwa: 0 },
    alerts: [
      { id: 'attribution', severity: 'high', title: 'Atribuição incompleta',
        detail: '86 conversas sem venda vinculada', target: 'jornadas' },
      { id: 'ctwa', severity: 'high', title: 'Referência CTWA ausente',
        detail: 'Nenhum ctwa_clid capturado', target: 'jornadas' },
      { id: 'capi', severity: 'attention', title: 'CAPI não configurada',
        detail: 'Retorno às plataformas bloqueado', target: 'integracoes' },
      { id: 'channels', severity: 'info', title: '2 canais desconectados',
        detail: 'Google e TikTok aguardando conexão', target: 'canais' },
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
      if (this.marketingLoading) return;
      this.marketingLoading = true;
      this.marketingError = null;
      try {
        this.marketingVisao = this.marketingIsMock()
          ? marketingMockPayload()
          : await this.apiGet(`/admin/api/marketing/overview?period=${encodeURIComponent(this.marketingPeriod)}`);
      } catch (error) {
        this.marketingError = 'Não foi possível carregar o Marketing agora.';
      } finally {
        this.marketingLoading = false;
        this.$nextTick(() => lucide.createIcons());
      }
    },

    marketingTabs() {
      return [
        { id: 'visao', label: 'Visão geral' },
        { id: 'canais', label: 'Canais' },
        { id: 'campanhas', label: 'Campanhas' },
        { id: 'criativos', label: 'Criativos' },
        { id: 'jornadas', label: 'Jornadas' },
        { id: 'geografia', label: 'Geografia e demanda' },
        { id: 'integracoes', label: 'Integrações' },
      ];
    },

    marketingSetTab(tab) {
      this.marketingTab = tab;
      this.$nextTick(() => lucide.createIcons());
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
        { id: 'conversations', label: 'Conversas', value: metrics.conversations ?? '—',
          detail: metrics.conversations == null ? 'Aguardando conexão' : 'iniciadas pelo anúncio', icon: 'messages-square' },
        { id: 'cost', label: 'Custo por conversa', value: money(metrics.cost_per_conversation),
          detail: 'investimento ÷ conversas', icon: 'badge-dollar-sign' },
        { id: 'sales', label: 'Vendas atribuídas', value: metrics.attributed_sales ?? '—',
          detail: 'atribuição pendente', icon: 'shopping-cart', tone: 'attention' },
        { id: 'profit', label: 'Lucro real', value: metrics.profit == null ? 'Não calculado' : money(metrics.profit),
          detail: 'bloqueado até a venda', icon: 'trending-up' },
      ];
    },

    marketingSeriesPoints(field) {
      const rows = this.marketingVisao?.series || [];
      if (!rows.length) return '';
      const max = Math.max(1, ...rows.map((row) => Number(row[field]) || 0));
      return rows.map((row, index) => {
        const x = rows.length === 1 ? 350 : 20 + (660 * index / (rows.length - 1));
        const y = 180 - ((Number(row[field]) || 0) / max * 145);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(' ');
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
      if (severity === 'high') return 'border-rose-200 bg-rose-50 text-rose-700';
      if (severity === 'attention') return 'border-amber-200 bg-amber-50 text-amber-700';
      return 'border-emerald-100 bg-emerald-50 text-emerald-800';
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
      if (status === 'error') return 'bg-rose-100 text-rose-700';
      if (status === 'planned') return 'bg-gray-100 text-gray-500';
      return 'bg-amber-100 text-amber-800';
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
        { label: 'Investimento', value: money(metrics.investment), icon: 'circle-dollar-sign' },
        { label: 'Conversas', value: metrics.conversations ?? '—', icon: 'messages-square' },
        { label: 'Demanda identificada', value: '—', icon: 'search' },
        { label: 'Vendas atribuídas', value: metrics.attributed_sales ?? '—', icon: 'shopping-cart' },
        { label: 'Lucro', value: metrics.profit == null ? '—' : money(metrics.profit), icon: 'trending-up' },
      ];
    },
  };
};
