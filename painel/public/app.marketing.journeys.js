// Marketing — Jornadas: Meta Insights + CTWA + analytics/commerce.
// Somente leitura. Nenhuma etapa comercial aparece sem vínculo determinístico.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};

function marketingJourneysMockPayload() {
  return {
    environment: 'test',
    generated_at: '2026-07-26T12:00:00.000Z',
    period: { id: '30d', days: 30, since: '2026-06-27', until: '2026-07-26' },
    connection: {
      meta: 'connected',
      meta_synced_at: '2026-07-26T11:55:00.000Z',
      attribution: 'disabled',
      capi: 'not_implemented',
    },
    metrics: {
      conversations: 86,
      ctwa: 0,
      tracking_coverage_percent: 0,
      attributed_sales: null,
      attributed_revenue: null,
    },
    stages: [
      { id: 'meta_conversations', label: 'Conversa Meta', value: 86, source: 'meta', status: 'ready', detail: 'Ação canônica registrada nos Insights.' },
      { id: 'ctwa', label: 'CTWA identificado', value: 0, source: 'farejador', status: 'attention', detail: 'referral.ctwa_clid persistido no webhook.' },
      { id: 'qualified', label: 'Lead qualificado', value: null, source: 'analytics', status: 'blocked', detail: 'Classificação stage_reached com proveniência.' },
      { id: 'quote', label: 'Orçamento', value: null, source: 'analytics', status: 'blocked', detail: 'Fato price_quoted posterior ao CTWA.' },
      { id: 'order', label: 'Pedido', value: null, source: 'analytics', status: 'blocked', detail: 'Fato pedido_criado posterior ao CTWA.' },
      { id: 'sale', label: 'Venda realizada', value: null, source: 'commerce', status: 'blocked', detail: 'Pedido não cancelado ligado à conversa.' },
    ],
    bottleneck: {
      id: 'ctwa_missing',
      severity: 'high',
      title: 'Rastreio interrompido antes do Farejador',
      detail: '86 conversa(s) na Meta e nenhum referral com ctwa_clid persistido.',
      target: 'integracoes',
    },
    quality: {
      meta_percent: 100,
      tracking_percent: 0,
      commercial_status: 'blocked',
      attribution_reliable: false,
    },
    campaigns: [
      { id: 'meta:1', name: '[18/06] Link do WhatsApp', investment: 82.47, conversations: 39, ctwa: 0, attributed_sales: null, bottleneck: 'ctwa_missing' },
      { id: 'meta:2', name: '[02/01] Campanha WhatsApp', investment: 88.38, conversations: 33, ctwa: 0, attributed_sales: null, bottleneck: 'ctwa_missing' },
      { id: 'meta:3', name: '[14/05] Campanha WhatsApp', investment: 27.21, conversations: 6, ctwa: 0, attributed_sales: null, bottleneck: 'ctwa_missing' },
    ],
  };
}

window.PAINEL_MODULES.marketingJourneys = function () {
  return {
    async loadMarketingJourneys() {
      if (this.marketingJourneysLoading) return;
      this.marketingJourneysLoading = true;
      this.marketingJourneysError = null;
      try {
        this.marketingJourneys = this.marketingIsMock()
          ? marketingJourneysMockPayload()
          : await this.apiGet(`/admin/api/marketing/journeys?period=${encodeURIComponent(this.marketingPeriod)}`);
      } catch {
        this.marketingJourneysError = 'Não foi possível carregar as Jornadas agora.';
      } finally {
        this.marketingJourneysLoading = false;
        this.$nextTick(() => lucide.createIcons());
      }
    },

    marketingJourneyKpis() {
      const metrics = this.marketingJourneys?.metrics || {};
      const money = (value) => value == null ? '—' : this.formatCurrency(Number(value));
      return [
        {
          id: 'conversations',
          label: 'Conversas iniciadas',
          value: metrics.conversations ?? '—',
          detail: 'Meta API',
          icon: 'messages-square',
          source: 'meta',
          blocked: false,
        },
        {
          id: 'ctwa',
          label: 'Conversas com CTWA',
          value: metrics.ctwa ?? '—',
          detail: 'Farejador',
          icon: 'mouse-pointer-click',
          source: 'farejador',
          blocked: false,
        },
        {
          id: 'coverage',
          label: 'Cobertura de rastreio',
          value: metrics.tracking_coverage_percent == null
            ? '—'
            : `${Number(metrics.tracking_coverage_percent).toLocaleString('pt-BR')}%`,
          detail: 'CTWA ÷ conversas',
          icon: 'percent',
          source: 'calculated',
          blocked: false,
        },
        {
          id: 'sales',
          label: 'Vendas atribuídas',
          value: metrics.attributed_sales ?? 'Aguardando CTWA',
          detail: metrics.attributed_sales == null ? 'atribuição bloqueada' : 'commerce.orders',
          icon: 'shopping-cart',
          source: metrics.attributed_sales == null ? 'blocked' : 'commerce',
          blocked: metrics.attributed_sales == null,
        },
        {
          id: 'revenue',
          label: 'Receita atribuída',
          value: metrics.attributed_revenue == null ? 'Aguardando vendas' : money(metrics.attributed_revenue),
          detail: metrics.attributed_revenue == null ? 'atribuição bloqueada' : 'pedidos não cancelados',
          icon: 'circle-dollar-sign',
          source: metrics.attributed_revenue == null ? 'blocked' : 'commerce',
          blocked: metrics.attributed_revenue == null,
        },
      ];
    },

    marketingJourneySourceLabel(source) {
      return {
        meta: 'Meta API',
        farejador: 'Farejador',
        analytics: 'Analytics',
        commerce: 'Commerce',
        calculated: 'Calculado',
        blocked: 'Bloqueado',
      }[source] || source;
    },

    marketingJourneySourceClass(source) {
      if (source === 'meta') return 'border-emerald-200 bg-emerald-50 text-emerald-800';
      if (source === 'farejador') return 'border-sky-200 bg-sky-50 text-sky-800';
      if (source === 'analytics' || source === 'calculated') return 'border-violet-200 bg-violet-50 text-violet-800';
      if (source === 'commerce') return 'border-emerald-200 bg-emerald-100 text-emerald-900';
      return 'border-amber-200 bg-amber-50 text-amber-800';
    },

    marketingJourneyStageIcon(id) {
      return {
        meta_conversations: 'messages-square',
        ctwa: 'mouse-pointer-click',
        qualified: 'badge-check',
        quote: 'receipt-text',
        order: 'package-check',
        sale: 'circle-check-big',
      }[id] || 'circle';
    },

    marketingJourneyStageClass(status) {
      if (status === 'ready') return 'border-emerald-400 bg-emerald-50 text-emerald-800';
      if (status === 'attention') return 'border-amber-400 bg-amber-50 text-amber-800';
      if (status === 'blocked') return 'border-gray-200 bg-gray-50 text-gray-400';
      return 'border-gray-300 bg-white text-gray-500';
    },

    marketingJourneyBottleneckClass() {
      const severity = this.marketingJourneys?.bottleneck?.severity;
      if (severity === 'ok') return 'border-emerald-200 bg-emerald-50 text-emerald-950';
      if (severity === 'info') return 'border-sky-200 bg-sky-50 text-sky-950';
      return 'border-amber-200 bg-amber-50 text-amber-950';
    },

    marketingJourneyBottleneckIcon() {
      return this.marketingJourneys?.bottleneck?.severity === 'ok'
        ? 'circle-check-big'
        : this.marketingJourneys?.bottleneck?.severity === 'info'
          ? 'info'
          : 'triangle-alert';
    },

    marketingJourneyCampaignBottleneck(row) {
      if (row.bottleneck === 'no_conversations') return 'Sem conversa';
      if (row.bottleneck === 'ctwa_missing') return 'CTWA ausente';
      return 'Mapeamento por anúncio pendente';
    },

    marketingJourneyCampaignClass(row) {
      return row.bottleneck === 'ctwa_missing'
        ? 'border-amber-200 bg-amber-50 text-amber-800'
        : 'border-gray-200 bg-gray-50 text-gray-600';
    },

    marketingJourneyCoverageWidth(value) {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return '0%';
      return `${Math.max(0, Math.min(100, parsed))}%`;
    },
  };
};
