// Marketing — Jornadas: Meta Insights + referência de mensagem + analytics/commerce.
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
      attribution: 'enabled',
      capi: 'disabled',
    },
    metrics: {
      conversations: 86,
      tracked: 61,
      ctwa: 45,
      messenger: 9,
      instagram: 7,
      tracking_coverage_percent: 70.9,
      attributed_sales: 7,
      attributed_revenue: 5840,
      total_realized_orders: 12,
      orders_with_conversation: 10,
      order_conversation_coverage_percent: 83.3,
    },
    stages: [
      { id: 'meta_conversations', label: 'Conversa Meta', value: 86, source: 'meta', status: 'ready', detail: 'Ação canônica registrada nos Insights.' },
      { id: 'ctwa', label: 'Origem identificada', value: 61, source: 'farejador', status: 'ready', detail: 'Referência de WhatsApp, Messenger ou Instagram persistida.' },
      { id: 'qualified', label: 'Avançou após cotação', value: 24, source: 'analytics', status: 'ready', detail: 'Classificação real quote_sent ou purchase_intent.' },
      { id: 'quote', label: 'Orçamento', value: 21, source: 'analytics', status: 'ready', detail: 'Fato price_quoted posterior à referência.' },
      { id: 'order', label: 'Pedido', value: 10, source: 'analytics', status: 'ready', detail: 'Fato pedido_criado posterior à referência.' },
      { id: 'sale', label: 'Venda realizada', value: 7, source: 'commerce', status: 'ready', detail: 'Entrega ou retirada realizada e ligada à conversa.' },
    ],
    bottleneck: {
      id: 'journey_active',
      severity: 'ok',
      title: 'Jornada rastreável ativa',
      detail: 'As vendas usam last-click de mensagem em até 7 dias e não reutilizam o clique.',
      target: 'jornadas',
    },
    quality: {
      meta_percent: 100,
      tracking_percent: 70.9,
      commercial_status: 'ready',
      attribution_reliable: true,
    },
    campaigns: [
      { id: 'meta:1', name: '[18/06] Link do WhatsApp', investment: 82.47, conversations: 39, ctwa: null, attributed_sales: 4, bottleneck: 'campaign_mapping_pending' },
      { id: 'meta:2', name: '[02/01] Campanha WhatsApp', investment: 88.38, conversations: 33, ctwa: null, attributed_sales: 3, bottleneck: 'campaign_mapping_pending' },
      { id: 'meta:3', name: '[14/05] Campanha WhatsApp', investment: 27.21, conversations: 6, ctwa: null, attributed_sales: 0, bottleneck: 'campaign_mapping_pending' },
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
          label: 'Origens identificadas',
          value: metrics.tracked ?? metrics.ctwa ?? '—',
          detail: 'WhatsApp + Messenger + Instagram',
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
          detail: 'origens ÷ conversas',
          icon: 'percent',
          source: 'calculated',
          blocked: false,
        },
        {
          id: 'order_coverage',
          label: 'Pedidos com conversa',
          value: metrics.orders_with_conversation == null || metrics.total_realized_orders == null
            ? '—'
            : `${metrics.orders_with_conversation} de ${metrics.total_realized_orders}`,
          detail: metrics.order_conversation_coverage_percent == null
            ? 'denominador indisponível'
            : `${Number(metrics.order_conversation_coverage_percent).toLocaleString('pt-BR')}% dos realizados`,
          icon: 'link-2',
          source: 'calculated',
          blocked: false,
        },
        {
          id: 'sales',
          label: 'Vendas atribuídas',
          value: metrics.attributed_sales ?? 'Aguardando origem',
          detail: metrics.attributed_sales == null ? 'atribuição bloqueada' : 'commerce.orders',
          icon: 'shopping-cart',
          source: metrics.attributed_sales == null ? 'blocked' : 'commerce',
          blocked: metrics.attributed_sales == null,
        },
        {
          id: 'revenue',
          label: 'Receita atribuída',
          value: metrics.attributed_revenue == null ? 'Aguardando vendas' : money(metrics.attributed_revenue),
          detail: metrics.attributed_revenue == null ? 'atribuição bloqueada' : 'vendas realizadas',
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
      if (row.bottleneck === 'ctwa_missing') return 'Origem ausente';
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
