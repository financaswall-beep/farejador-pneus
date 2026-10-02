// Visão geral do Google: apresentação sobre o relatório e a apuração existentes.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.marketingGoogleOverview = function () {
  return {
    googleCampaignDecision: 'all', googleCampaignStatus: '', googleCampaignExpanded: false,
    googleCampaignSort: 'investment', googleCampaignAscending: false,
    googleOverviewMetrics() {
      const m = this.googleAdsReport?.data?.totals || {};
      const r = this.googleAdsReport?.results;
      const financial = r?.available ? r.totals || {} : {};
      return {
        ...m, ...financial,
        result: financial.gross_margin != null && m.investment != null
          ? financial.gross_margin - m.investment : null,
        roas: m.investment > 0 && financial.attributed_revenue != null
          ? financial.attributed_revenue / m.investment : null,
      };
    },
    googleOverviewKpis() {
      const m = this.googleOverviewMetrics();
      return [
        { id: 'investment', label: 'Investimento', value: this.paidMoney(m.investment), icon: 'coins', detail: 'Google Ads · no período' },
        { id: 'clicks', label: 'Cliques', value: this.paidNumber(m.clicks), icon: 'mouse-pointer-2', detail: 'Cliques nos anúncios' },
        { id: 'cpc', label: 'Custo por clique', value: this.paidMoney(m.cpc), icon: 'tag', detail: 'Investimento ÷ cliques' },
        { id: 'sales', label: 'Vendas atribuídas', value: this.paidNumber(m.attributed_sales), icon: 'shopping-cart', detail: 'Confirmadas no Farejador' },
        { id: 'revenue', label: 'Receita atribuída', value: this.paidMoney(m.attributed_revenue), icon: 'banknote', detail: 'Vendas vinculadas aos anúncios' },
        { id: 'result', label: 'Resultado após mídia', value: this.paidMoney(m.result), icon: 'trending-up',
          negative: m.result < 0, detail: m.pending_margin_orders > 0
            ? `${m.pending_margin_orders} venda(s) sem custo completo` : 'Receita − custos das vendas − mídia' },
      ];
    },
    googleOverviewIndicators() {
      const m = this.googleOverviewMetrics();
      const decimal = value => value == null ? '—' : Number(value).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      return [
        { label: 'Impressões', value: this.paidNumber(m.impressions), icon: 'eye' },
        { label: 'CTR', value: m.ctr == null ? '—' : decimal(m.ctr) + '%', icon: 'chart-no-axes-column-increasing' },
        { label: 'Conversões Google', value: this.paidNumber(m.conversions), icon: 'goal' },
        { label: 'Conversas identificadas', value: this.paidNumber(m.tracked_conversations), icon: 'messages-square' },
        { label: 'ROAS', value: decimal(m.roas), icon: 'trending-up' },
      ];
    },
    googleOverviewRows() {
      const search = this.googleAdsSearch.trim().toLocaleLowerCase('pt-BR');
      return (this.googleAdsReport?.data?.campaigns || []).map(row => {
        const result = this.googleResult(row, 'campaign');
        const financial = this.googleAdsReport?.results?.campaigns?.find(item => item.id === row.id);
        return { ...row, ...result, pending_margin_orders: financial?.pending_margin_orders || 0 };
      }).filter(row => (!search || `${row.name} ${row.id}`.toLocaleLowerCase('pt-BR').includes(search))
        && (!this.googleCampaignStatus || row.status === this.googleCampaignStatus)
        && (this.googleCampaignDecision === 'all'
          || this.googleCampaignDecision === 'review' && row.pending_margin_orders > 0
          || this.googleCampaignDecision === 'monitor' && row.delivery_days > 0))
        .sort((a, b) => {
          const key = this.googleCampaignSort, direction = this.googleCampaignAscending ? 1 : -1;
          if (key === 'name') return direction * a.name.localeCompare(b.name, 'pt-BR');
          if (a[key] == null) return b[key] == null ? 0 : 1;
          if (b[key] == null) return -1;
          return direction * (Number(a[key]) - Number(b[key]));
        });
    },
    googleCampaignOrder(key) {
      this.googleCampaignAscending = this.googleCampaignSort === key ? !this.googleCampaignAscending : key === 'name';
      this.googleCampaignSort = key;
      this.googleAdsPage = 1;
    },
    googleCampaignReset() {
      this.googleAdsSearch = ''; this.googleCampaignStatus = ''; this.googleCampaignDecision = 'all'; this.googleAdsPage = 1;
    },
    googleCampaignType(type) {
      return { SEARCH: 'Pesquisa', DISPLAY: 'Display', VIDEO: 'Vídeo', SHOPPING: 'Shopping',
        PERFORMANCE_MAX: 'Performance Max', DEMAND_GEN: 'Demand Gen', MULTI_CHANNEL: 'Aplicativo', SMART: 'Inteligente' }[type] || 'Outro';
    },
    googleSetView(view, campaign = '') {
      this.googleAdsView = view;
      this.googleAdsCampaign = campaign;
      this.googleAdsSearch = '';
      this.googleAdPage = 1;
      this.$nextTick(() => {
        lucide.createIcons();
        if (view === 'campaigns') this.renderGoogleOverviewChart();
        document.querySelector('[data-marketing-google-screen]')?.scrollIntoView({ block: 'start' });
      });
    },
    googleStartCompare() {
      if (this.googleAdsSelected.length === 2) this.googleShowCompare();
      else this.googleSetView('ads');
    },
    googlePipeline() { return this.googleAdsReport?.results?.pipeline || null; },
    googlePipelineCount(kind) {
      const p = this.googlePipeline();
      if (!p?.available) return '—';
      const count = kind === 'queued' ? p.pending + p.processing + p.accepted
        : kind === 'errors' ? p.failed + p.dead_letter : p[kind];
      return this.paidNumber(count);
    },
    googlePipelineStatus() {
      const r = this.googleAdsReport?.results;
      if (!r?.available) return 'Indisponível';
      if (!r.conversions_enabled || !r.conversion_action_configured) return 'Desativado';
      return r.conversion_destination?.state === 'ready' ? 'Automático' : 'Aguardando validação';
    },
    googleLastSentLabel() {
      const at = this.googlePipeline()?.last_sent_at;
      return at ? `Última confirmação em ${new Date(at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}`
        : 'Vendas atribuídas no período';
    },
    googleOverviewAlerts() {
      const r = this.googleAdsReport?.results, p = this.googlePipeline(), m = this.googleOverviewMetrics();
      if (!r?.available) return [{ id: 'results', title: 'Apuração indisponível', detail: 'Não foi possível consultar as vendas e os custos.', target: 'reload' }];
      const rows = [];
      if (m.pending_margin_orders > 0) rows.push({ id: 'costs', title: `${m.pending_margin_orders} venda(s) sem custo completo`,
        detail: 'Confira os custos nos pedidos vinculados.', target: 'setup' });
      if (!r.conversions_enabled || !r.conversion_action_configured) rows.push({ id: 'disabled', title: 'Retorno das vendas desativado',
        detail: 'Confira a configuração do envio ao Google.', target: 'setup' });
      else if (r.conversion_destination?.state !== 'ready') rows.push({ id: 'destination', title: 'Destino de conversão aguarda validação',
        detail: 'As vendas permanecem na fila até a validação.', target: 'setup' });
      if (p?.available && p.failed + p.dead_letter > 0) rows.push({ id: 'failed', title: `${p.failed + p.dead_letter} envio(s) com falha`,
        detail: 'Confira a situação antes de tentar novamente.', target: 'setup' });
      if (p?.available && p.review > 0) rows.push({ id: 'review', title: `${p.review} envio(s) precisam de conferência`,
        detail: 'A entrega não será repetida sem confirmação.', target: 'setup' });
      if (p?.available && p.pending + p.processing + p.accepted > 0) rows.push({ id: 'queue',
        title: `${p.pending + p.processing + p.accepted} conversão(ões) aguardando confirmação`, detail: 'Acompanhe o retorno do Google.', target: 'setup' });
      return rows;
    },
    googleAlertOpen(alert) {
      if (alert.target === 'reload') void this.loadGoogleAds();
      else this.googleSetView('setup');
    },
    googleCostStatus() {
      const m = this.googleOverviewMetrics();
      if (m.pending_margin_orders == null) return 'Indisponível';
      if (m.pending_margin_orders > 0) return `${m.pending_margin_orders} pendente(s)`;
      return m.attributed_sales > 0 ? 'Completos' : 'Sem vendas no período';
    },
    googleOverviewSeries() {
      const data = this.googleAdsReport?.data, period = data?.period;
      if (!period) return [];
      const byDay = new Map((data.daily || []).map(row => [row.date, row]));
      const rows = [];
      for (let at = Date.parse(period.since + 'T12:00:00Z'), end = Date.parse(period.until + 'T12:00:00Z'); at <= end; at += 86400000) {
        const date = new Date(at).toISOString().slice(0, 10), day = byDay.get(date);
        rows.push({ date, spend: day?.investment ?? 0, clicks: day?.clicks ?? 0 });
      }
      return rows;
    },
    renderGoogleOverviewChart() {
      if (this.marketingCampaignChannel !== 'google' || this.googleAdsView !== 'campaigns') return;
      this.renderMarketingSeries({ canvasId: 'chartGoogleOverview', chartKey: '_googleOverviewChart',
        rows: this.googleOverviewSeries(), seriesKey: 'clicks', seriesLabel: 'Cliques' });
    },
  };
};
