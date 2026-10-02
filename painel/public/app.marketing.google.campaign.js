// Detalhe de campanha: mesma apuração e mesmo retorno de vendas do Google Ads.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.marketingGoogleCampaign = function () {
  return {
    googleCampaignId: '', googleCampaignTab: 'result', googleCampaignReturnId: '',
    googleCampaignActivity: null, googleCampaignActivityLoading: false, googleCampaignActivityError: '',
    googleCampaignActivitySeq: 0, googleCampaignOrderPage: 1, googleCampaignConversationPage: 1,
    googleCampaignAdSearch: '', googleCampaignAdPage: 1, googleCampaignEventsOpen: false,
    googleCampaignRow() {
      return (this.googleAdsReport?.data?.campaigns || []).find(row => row.id === this.googleCampaignId) || null;
    },
    googleCampaignMetrics() {
      const row = this.googleCampaignRow();
      return row ? { ...row, ...this.googleResult(row, 'campaign') } : {};
    },
    googleOpenCampaign(id) {
      if (!(this.googleAdsReport?.data?.campaigns || []).some(row => row.id === id)) return;
      this.googleCampaignId = id;
      this.googleCampaignReturnId = id;
      this.googleCampaignTab = 'result'; this.googleCampaignAdSearch = ''; this.googleCampaignAdPage = 1;
      this.googleCampaignOrderPage = 1; this.googleCampaignConversationPage = 1;
      this.googleCampaignEventsOpen = false; this.googleAdsSelected = [];
      this.googleSetView('campaign', id);
      void this.loadGoogleCampaignActivity();
    },
    googleReturnCampaign() {
      if (!this.googleCampaignReturnId) return;
      this.googleCampaignId = this.googleCampaignReturnId;
      if (!this.googleCampaignRow()) { this.googleSetView('campaigns'); return; }
      this.googleSetView('campaign', this.googleCampaignId);
      if (!this.googleCampaignActivity && !this.googleCampaignActivityLoading) void this.loadGoogleCampaignActivity();
    },
    googleCampaignTabs() {
      return [{ id: 'result', label: 'Resultado' },
        { id: 'ads', label: `Anúncios (${this.googleCampaignAds().length})` },
        { id: 'sales', label: 'Conversas e vendas' }, { id: 'finance', label: 'Composição financeira' }];
    },
    googleCampaignSetTab(tab) {
      if (!this.googleCampaignTabs().some(row => row.id === tab)) return;
      this.googleCampaignTab = tab;
      this.$nextTick(() => { lucide.createIcons(); this.renderGoogleCampaignChart(); });
    },
    googleCampaignKpis() {
      const m = this.googleCampaignMetrics();
      return [{ id: 'investment', label: 'Investimento', value: this.paidMoney(m.investment), icon: 'coins', note: 'Google Ads · no período' },
        { id: 'clicks', label: 'Cliques', value: this.paidNumber(m.clicks), icon: 'mouse-pointer-2', note: `CPC ${this.paidMoney(m.cpc)}` },
        { id: 'sales', label: 'Vendas atribuídas', value: this.paidNumber(m.attributed_sales), icon: 'shopping-cart', note: `Receita de ${this.paidMoney(m.attributed_revenue)}` },
        { id: 'result', label: 'Resultado após mídia', value: this.paidMoney(m.result), icon: 'chart-no-axes-column-increasing',
          negative: m.result < 0, note: m.pending_margin_orders > 0 ? 'Custos pendentes de conferência' : `ROAS ${m.roas == null ? '—' : Number(m.roas).toLocaleString('pt-BR', {maximumFractionDigits:2})}` }];
    },
    googleCampaignIndicators() {
      const m = this.googleCampaignMetrics();
      return [{ label: 'Impressões', value: this.paidNumber(m.impressions), icon: 'eye' },
        { label: 'CTR', value: m.ctr == null ? '—' : this.paidNumber(m.ctr) + '%', icon: 'chart-no-axes-column' },
        { label: 'Mídia por venda', value: this.paidMoney(m.attributed_sales > 0 ? m.investment / m.attributed_sales : null), icon: 'coins' },
        { label: 'Conversas identificadas', value: this.paidNumber(m.tracked_conversations), icon: 'messages-square' },
        { label: 'Conversões Google', value: this.paidNumber(m.conversions), icon: 'goal' }];
    },
    googleCampaignFinancialRows() {
      const m = this.googleCampaignMetrics();
      return [{ id: 'revenue', label: 'Receita atribuída', value: m.attributed_revenue, kind: 'positive' },
        { id: 'cost', label: 'Custo dos pneus / produtos', value: m.product_cost == null ? null : -m.product_cost },
        { id: 'payout', label: 'Repasses aos parceiros', value: m.partner_payout == null ? null : -m.partner_payout },
        { id: 'media', label: 'Investimento em mídia', value: m.investment == null ? null : -m.investment, kind: 'media' },
        { id: 'result', label: 'Resultado após mídia', value: m.result, kind: 'result' }];
    },
    googleCampaignBar(value) {
      if (value == null) return '0%';
      const max = Math.max(1, ...this.googleCampaignFinancialRows().map(row => Math.abs(row.value || 0)));
      return `${Math.min(100, Math.abs(value) / max * 100)}%`;
    },
    googleCampaignRetained() {
      const m = this.googleCampaignMetrics();
      return m.attributed_revenue > 0 && m.result != null ? m.result / m.attributed_revenue * 100 : null;
    },
    googleCampaignCostsLabel() {
      const m = this.googleCampaignMetrics();
      if (m.attributed_sales == null || m.pending_margin_orders == null) return 'Indisponível';
      return `${this.paidNumber(m.attributed_sales - m.pending_margin_orders)} de ${this.paidNumber(m.attributed_sales)}`;
    },
    googleCampaignAds() {
      return (this.googleAdsReport?.data?.ads || []).filter(ad => ad.campaign_id === this.googleCampaignId)
        .map(ad => ({ ...ad, ...this.googleResult(ad) })).sort((a, b) => b.investment - a.investment || a.id.localeCompare(b.id));
    },
    googleCampaignAdRows() {
      const query = this.googleCampaignAdSearch.trim().toLocaleLowerCase('pt-BR');
      return this.googleCampaignAds().filter(ad => !query || `${ad.name} ${ad.ad_id} ${ad.ad_group_id}`.toLocaleLowerCase('pt-BR').includes(query));
    },
    googleCampaignAdPages() { return Math.max(1, Math.ceil(this.googleCampaignAdRows().length / 10)); },
    googleCampaignAdPageRows() {
      if (this.googleCampaignTab === 'result') return this.googleCampaignAds().slice(0, 5);
      const page = Math.min(this.googleCampaignAdPage, this.googleCampaignAdPages());
      return this.googleCampaignAdRows().slice((page - 1) * 10, page * 10);
    },
    googleCampaignCompare() {
      const ids = new Set(this.googleCampaignAds().map(ad => ad.id));
      this.googleAdsSelected = this.googleAdsSelected.filter(id => ids.has(id));
      if (this.googleAdsSelected.length === 2) this.googleShowCompare();
      else this.googleCampaignSetTab('ads');
    },
    googleCampaignPipeline() {
      const r = this.googleAdsReport?.results;
      if (!r?.available || !r.campaign_pipelines) return null;
      return r.campaign_pipelines[this.googleCampaignId] || { available: true, sent: 0, pending: 0,
        processing: 0, accepted: 0, failed: 0, dead_letter: 0, review: 0, suppressed: 0 };
    },
    googleCampaignPipelineCount(kind) {
      const p = this.googleCampaignPipeline();
      if (!p?.available) return '—';
      return this.paidNumber(kind === 'queued' ? p.pending + p.processing + p.accepted
        : kind === 'errors' ? p.failed + p.dead_letter : p[kind]);
    },
    googleCampaignSeries() {
      const data = this.googleAdsReport?.data, period = data?.period;
      if (!period || !Array.isArray(data.campaign_daily)) return [];
      const days = new Map(data.campaign_daily.filter(row => row.campaign_id === this.googleCampaignId).map(row => [row.date, row]));
      const rows = [];
      for (let at = Date.parse(period.since + 'T12:00:00Z'), end = Date.parse(period.until + 'T12:00:00Z'); at <= end; at += 86400000) {
        const date = new Date(at).toISOString().slice(0, 10), day = days.get(date);
        rows.push({ date, spend: day ? Number(day.cost_micros) / 1e6 : 0, clicks: day?.clicks || 0 });
      }
      return rows;
    },
    renderGoogleCampaignChart() {
      if (this.marketingCampaignChannel !== 'google' || this.googleAdsView !== 'campaign' || this.googleCampaignTab !== 'result') return;
      this.renderMarketingSeries({ canvasId: 'chartGoogleCampaign', chartKey: '_googleCampaignChart',
        rows: this.googleCampaignSeries(), seriesKey: 'clicks', seriesLabel: 'Cliques' });
    },
    googleCampaignManagerUrl() {
      const account = this.googleAdsReport?.data?.account?.id, id = this.googleCampaignId;
      return /^\d+$/.test(account || '') && /^\d+$/.test(id) ? `https://ads.google.com/aw/campaigns?customerId=${account}&campaignId=${id}` : '';
    },
    googleCampaignDate(value) {
      return value ? new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }) : '—';
    },
    googleCampaignConversationStatus(status) {
      return { open: 'Aberta', resolved: 'Resolvida', pending: 'Pendente', snoozed: 'Adiada' }[status] || 'Não informado';
    },
    googleCampaignInvalidateActivity() {
      this.googleCampaignActivitySeq++;
      this.googleCampaignActivity = null; this.googleCampaignActivityError = ''; this.googleCampaignActivityLoading = false;
    },
    async loadGoogleCampaignActivity() {
      if (!this.googleCampaignRow()) return;
      const seq = ++this.googleCampaignActivitySeq, id = this.googleCampaignId, period = this.marketingPeriod;
      this.googleCampaignActivityLoading = true; this.googleCampaignActivityError = ''; this.googleCampaignActivity = null;
      try {
        const report = this.marketingIsMock() ? { available: false }
          : await this.apiGet(`/admin/api/marketing/google-ads/campaign?campaign_id=${encodeURIComponent(id)}&period=${encodeURIComponent(period)}&order_page=${this.googleCampaignOrderPage}&conversation_page=${this.googleCampaignConversationPage}`);
        if (seq === this.googleCampaignActivitySeq && id === this.googleCampaignId && period === this.marketingPeriod) this.googleCampaignActivity = report;
      } catch {
        if (seq === this.googleCampaignActivitySeq) this.googleCampaignActivityError = 'Não foi possível consultar as conversas, vendas e envios desta campanha.';
      } finally {
        if (seq === this.googleCampaignActivitySeq) {
          this.googleCampaignActivityLoading = false;
          this.$nextTick(() => lucide.createIcons());
        }
      }
    },
    googleCampaignActivityPages(kind) {
      const page = this.googleCampaignActivity?.[kind];
      return Math.max(1, Math.ceil((page?.total || 0) / (this.googleCampaignActivity?.page_size || 25)));
    },
    googleCampaignActivityNavigate(kind, direction) {
      if (this.googleCampaignActivityLoading || !['orders', 'conversations'].includes(kind)) return;
      const key = kind === 'orders' ? 'googleCampaignOrderPage' : 'googleCampaignConversationPage';
      this[key] = Math.max(1, Math.min(this.googleCampaignActivityPages(kind), this[key] + direction));
      void this.loadGoogleCampaignActivity();
    },
  };
};
