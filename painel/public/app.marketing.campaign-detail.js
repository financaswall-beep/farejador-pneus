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
      channel: 'meta', status: 'with_delivery', currency: 'BRL',
      delivery_days: row?.delivery_days || 1, last_delivery: row?.last_delivery || '2026-07-25',
    },
    summary: {
      investment, impressions: Number(row?.impressions || 0), clicks: Number(row?.clicks || 0),
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
      id: 'ad-1', name: 'Criativo WhatsApp 01', adset_name: 'Público local',
      investment, impressions: Number(row?.impressions || 0), clicks: Number(row?.clicks || 0),
      conversations_started: conversations, first_replies: replies,
      response_rate: conversations ? replies / conversations * 100 : null,
      cost_per_replied: replies ? investment / replies : null,
      attributed_sales: sales, attributed_revenue: revenue, gross_margin: margin,
      net_after_media: margin - investment,
      roas: investment ? revenue / investment : null,
    }],
    attribution: {
      status: 'ready', method: 'last_click_ctwa_7d', attributed_sales: sales,
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
      attributed_sales: sales, complete_cost_orders: Math.max(0, sales - 1),
      conversion_rate: sales ? sales / 28 * 100 : null,
    },
    orders_total: sales,
    orders: [
      { order_number: 'PED-10482', realized_at: '2026-07-24T14:32:00.000Z', origin: 'CTWA',
        revenue: 890, gross_margin: 312, time_to_sale_minutes: 138, status: 'confirmed' },
      { order_number: 'PED-10471', realized_at: '2026-07-23T10:08:00.000Z', origin: 'CTWA',
        revenue: 1240, gross_margin: 405, time_to_sale_minutes: 1122, status: 'confirmed' },
      { order_number: 'PED-10455', realized_at: '2026-07-21T16:51:00.000Z', origin: 'CTWA',
        revenue: 650, gross_margin: 208, time_to_sale_minutes: 4320, status: 'confirmed' },
    ],
    decision: {
      tone: 'attention', title: 'Há espaço para recuperar conversas sem resposta',
      detail: 'Antes de ampliar a verba, verifique fila, escala e horário de atendimento.',
    },
  };
}

window.PAINEL_MODULES.marketingCampaignDetail = function () {
  return {
    async openMarketingCampaignDetail(row) {
      if (!row?.platform_id) return;
      this.marketingCampaignDetailId = row.platform_id;
      this.marketingCampaignDetail = null;
      this.marketingCampaignDetailError = null;
      document.querySelector('main')?.scrollTo({ top: 0, behavior: 'smooth' });
      await this.loadMarketingCampaignDetail();
    },

    closeMarketingCampaignDetail() {
      this.marketingCampaignDetailRequestSeq += 1;
      this.marketingCampaignDetailId = null;
      this.marketingCampaignDetail = null;
      this.marketingCampaignDetailError = null;
      this.marketingCampaignDetailLoading = false;
      this.$nextTick(() => lucide.createIcons());
      document.querySelector('main')?.scrollTo({ top: 0, behavior: 'smooth' });
    },

    async loadMarketingCampaignDetail() {
      const campaignId = this.marketingCampaignDetailId;
      if (!campaignId) return;
      const requestSeq = ++this.marketingCampaignDetailRequestSeq;
      this.marketingCampaignDetailLoading = true;
      this.marketingCampaignDetailError = null;
      try {
        const selected = this.marketingCampaigns?.campaigns?.find(
          (row) => row.platform_id === campaignId,
        );
        const payload = this.marketingIsMock()
          ? marketingCampaignDetailMock(selected, this.marketingPeriod)
          : await this.apiGet(`/admin/api/marketing/campaigns/${encodeURIComponent(campaignId)}?period=${encodeURIComponent(this.marketingPeriod)}`);
        if (requestSeq === this.marketingCampaignDetailRequestSeq) {
          this.marketingCampaignDetail = payload;
        }
      } catch {
        if (requestSeq === this.marketingCampaignDetailRequestSeq) {
          this.marketingCampaignDetailError = 'Não foi possível carregar o detalhe desta campanha.';
        }
      } finally {
        if (requestSeq === this.marketingCampaignDetailRequestSeq) {
          this.marketingCampaignDetailLoading = false;
          this.$nextTick(() => lucide.createIcons());
        }
      }
    },

    marketingCampaignDetailKpis() {
      const detail = this.marketingCampaignDetail || {};
      const summary = detail.summary || {};
      const financial = detail.financial || {};
      const money = (value) => value == null ? '—' : this.formatCurrency(Number(value));
      const number = (value) => value == null ? '—' : Number(value).toLocaleString('pt-BR');
      return [
        { id: 'investment', label: 'Investimento', value: money(summary.investment), source: 'META' },
        { id: 'sales', label: 'Vendas atribuídas', value: number(financial.attributed_sales), source: 'FAREJADOR' },
        { id: 'revenue', label: 'Receita atribuída', value: money(financial.attributed_revenue), source: 'FAREJADOR' },
        { id: 'margin', label: 'Margem bruta', value: money(financial.gross_margin), source: 'FAREJADOR' },
        { id: 'result', label: 'Resultado após mídia', value: money(financial.net_after_media), source: 'CALCULADO',
          tone: financial.net_after_media == null ? '' : Number(financial.net_after_media) >= 0 ? 'positive' : 'negative' },
        { id: 'roas', label: 'ROAS', value: financial.roas == null ? '—' : `${Number(financial.roas).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}x`, source: 'CALCULADO' },
        { id: 'cac', label: 'CAC real', value: money(financial.cac), source: 'CALCULADO' },
      ];
    },

    marketingCampaignDetailSourceClass(source) {
      if (source === 'META') return 'border-sky-300 bg-sky-50 text-sky-700';
      if (source === 'FAREJADOR') return 'border-emerald-300 bg-emerald-50 text-emerald-700';
      return 'border-amber-300 bg-amber-50 text-amber-700';
    },

    marketingCampaignResponseDelta() {
      const summary = this.marketingCampaignDetail?.summary;
      if (!summary?.cost_per_started || !summary?.cost_per_replied) return null;
      return ((summary.cost_per_replied / summary.cost_per_started) - 1) * 100;
    },

    marketingCampaignDetailFinancialRows() {
      const financial = this.marketingCampaignDetail?.financial || {};
      const investment = this.marketingCampaignDetail?.summary?.investment;
      return [
        { id: 'revenue', label: 'Receita atribuída', value: financial.attributed_revenue, kind: 'positive' },
        { id: 'products', label: 'Custo dos produtos', value: financial.product_cost == null ? null : -Number(financial.product_cost), kind: 'neutral' },
        { id: 'operation', label: 'Custos, repasses e operação', value: financial.operation_cost == null ? null : -Number(financial.operation_cost), kind: 'neutral' },
        { id: 'media', label: 'Investimento Meta', value: investment == null ? null : -Number(investment), kind: 'media' },
        { id: 'result', label: 'Resultado após mídia', value: financial.net_after_media, kind: 'result' },
      ];
    },

    marketingCampaignFinancialPercent(value) {
      const revenue = Number(this.marketingCampaignDetail?.financial?.attributed_revenue || 0);
      if (value == null || revenue <= 0) return null;
      return Math.abs(Number(value)) / revenue * 100;
    },

    marketingCampaignFinancialBar(value) {
      const percent = this.marketingCampaignFinancialPercent(value);
      return `${Math.min(100, Math.max(0, percent || 0))}%`;
    },

    marketingCampaignOrderDate(value) {
      if (!value) return '—';
      return new Intl.DateTimeFormat('pt-BR', {
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
        timeZone: 'America/Sao_Paulo',
      }).format(new Date(value)).replace('.', '');
    },

    marketingCampaignSaleTime(minutes) {
      const value = Number(minutes || 0);
      if (value < 60) return `${value} min`;
      if (value < 1440) return `${Math.floor(value / 60)}h ${value % 60}min`;
      const days = Math.floor(value / 1440);
      const hours = Math.floor((value % 1440) / 60);
      return hours ? `${days}d ${hours}h` : `${days} dia(s)`;
    },

    marketingCampaignQualityKpis() {
      const quality = this.marketingCampaignDetail?.quality || {};
      return [
        { id: 'conversations', label: 'Conversas Meta', value: quality.conversations_meta ?? '—', source: 'META', icon: 'messages-square' },
        { id: 'ctwa', label: 'CTWAs identificados', value: quality.ctwa_referrals ?? '—', source: 'FAREJADOR', icon: 'map-pin-check' },
        { id: 'sales', label: 'Vendas atribuídas', value: quality.attributed_sales ?? '—', source: 'FAREJADOR', icon: 'shopping-bag' },
        { id: 'costs', label: 'Pedidos com custo completo',
          value: quality.attributed_sales == null ? '—' : `${quality.complete_cost_orders || 0} de ${quality.attributed_sales}`,
          source: 'FAREJADOR', icon: 'clipboard-check' },
      ];
    },

    marketingCampaignDecisionItems() {
      const detail = this.marketingCampaignDetail || {};
      const result = detail.financial?.net_after_media;
      const conversion = detail.quality?.conversion_rate;
      return [
        result == null
          ? 'Resultado financeiro aguardando atribuição e custos'
          : result >= 0 ? 'Campanha pagou a mídia e gerou resultado positivo'
            : 'Campanha ainda não pagou o investimento em mídia',
        conversion == null
          ? 'Conversão CTWA → venda ainda não calculada'
          : `Conversão CTWA → venda: ${Number(conversion).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`,
        'Nenhuma verba será alterada automaticamente',
      ];
    },

    marketingCampaignDetailDecisionClass(tone) {
      if (tone === 'critical') return 'border-rose-200 bg-rose-50 text-rose-800';
      if (tone === 'attention') return 'border-amber-200 bg-amber-50 text-amber-900';
      return 'border-emerald-200 bg-emerald-50 text-emerald-900';
    },

    marketingCampaignAttributionLabel(status) {
      const labels = {
        ready: 'Atribuição CTWA disponível',
        pending: 'Aguardando primeira venda atribuída',
        disabled: 'Atribuição CTWA desligada',
        unavailable: 'Atribuição temporariamente indisponível',
      };
      return labels[status] || 'Aguardando atribuição';
    },
  };
};
