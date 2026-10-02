// Anúncio individual: leitura do mesmo motor financeiro, sem alterar campanhas ou envios.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.marketingGoogleDetail = function () {
  return {
    googleDetailTab: 'result', googleDetailCalculation: false, googleDetailReturnView: '',
    googleDetailActivity: null, googleDetailLoading: false, googleDetailError: '',
    googleDetailSeq: 0, googleDetailOrderPage: 1, googleDetailConversationPage: 1,
    googleDetailRow() { return this.googleAdById(this.googleAdsDetailId) || null; },
    googleDetailStatus() {
      return { ENABLED: 'Ativo', PAUSED: 'Pausado', REMOVED: 'Removido' }[this.googleDetailRow()?.status] || 'Não informado';
    },
    googleDetailMetrics() {
      const ad = this.googleDetailRow();
      return ad ? { ...ad, ...this.googleResult(ad) } : {};
    },
    googleDetailOpen() {
      this.googleDetailTab = 'result'; this.googleDetailCalculation = false;
      this.googleDetailOrderPage = 1; this.googleDetailConversationPage = 1;
      void this.loadGoogleDetailActivity();
      this.$nextTick(() => {
        lucide.createIcons(); this.renderGoogleDetailChart();
        document.querySelector('[data-google-ad-detail]')?.scrollIntoView({ block: 'start' });
      });
    },
    googleDetailBack() {
      if (this.googleDetailReturnView === 'compare' && this.googleCompareValid?.()) {
        this.googleAdsView = 'compare'; this.googleCompareOpen(); return;
      }
      if (this.googleCampaignReturnId) { this.googleReturnCampaign(); return; }
      this.googleAdsView = 'ads';
      this.$nextTick(() => { lucide.createIcons(); document.querySelector('[data-google-ad-gallery]')?.scrollIntoView({ block: 'start' }); });
    },
    googleDetailSetTab(tab) {
      if (!['result', 'sales', 'events'].includes(tab)) return;
      this.googleDetailTab = tab;
      if (tab === 'result' && this.googleDetailOrderPage !== 1) {
        this.googleDetailOrderPage = 1; void this.loadGoogleDetailActivity();
      }
      this.$nextTick(() => { lucide.createIcons(); this.renderGoogleDetailChart(); });
    },
    googleDetailDelivery() {
      const m = this.googleDetailMetrics();
      return [
        { label: 'Investimento', value: this.paidMoney(m.investment) },
        { label: 'Impressões', value: this.paidNumber(m.impressions) },
        { label: 'Cliques', value: this.paidNumber(m.clicks) },
        { label: 'CTR', value: m.ctr == null ? '—' : Number(m.ctr).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + '%' },
        { label: 'Custo por clique', value: this.paidMoney(m.cpc) },
        { label: 'CPM', value: this.paidMoney(m.cpm) },
        { label: 'Conversões Google', value: this.paidNumber(m.conversions) },
        { label: 'Valor de conversão Google', value: this.paidMoney(m.conversion_value) },
      ];
    },
    googleDetailSales() {
      const m = this.googleDetailMetrics();
      return [
        { label: 'Conversas identificadas', value: this.paidNumber(m.tracked_conversations) },
        { label: 'Vendas atribuídas', value: this.paidNumber(m.attributed_sales) },
        { label: 'Receita atribuída', value: this.paidMoney(m.attributed_revenue) },
        { label: 'Custo dos pneus / produtos', value: this.paidMoney(m.product_cost) },
        { label: 'Resultado após mídia', value: this.paidMoney(m.result), result: true, negative: m.result < 0 },
        { label: 'ROAS', value: m.roas == null ? '—' : Number(m.roas).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) },
      ];
    },
    googleDetailFinancial() {
      const m = this.googleDetailMetrics();
      return [
        { label: 'Receita atribuída', value: m.attributed_revenue },
        { label: 'Custo dos pneus / produtos', value: m.product_cost == null ? null : -m.product_cost },
        { label: 'Repasses aos parceiros', value: m.partner_payout == null ? null : -m.partner_payout },
        { label: 'Investimento em mídia', value: m.investment == null ? null : -m.investment },
        { label: 'Resultado após mídia', value: m.result },
      ];
    },
    googleDetailFormula() {
      const m = this.googleDetailMetrics();
      if ([m.attributed_revenue, m.product_cost, m.partner_payout, m.investment, m.result].some(n => n == null)) return 'Cálculo aguardando custos completos.';
      return this.paidMoney(m.attributed_revenue) + ' − ' + this.paidMoney(m.product_cost)
        + (m.partner_payout ? ' − ' + this.paidMoney(m.partner_payout) : '')
        + ' − ' + this.paidMoney(m.investment) + ' = ' + this.paidMoney(m.result);
    },
    googleDetailMediaPerSale() {
      const m = this.googleDetailMetrics();
      return this.paidMoney(m.attributed_sales > 0 ? m.investment / m.attributed_sales : null);
    },
    googleDetailCampaign() {
      return (this.googleAdsReport?.data?.campaigns || []).find(c => c.id === this.googleDetailRow()?.campaign_id) || null;
    },
    googleDetailCampaignCpc() {
      const c = this.googleDetailCampaign();
      return c?.clicks > 0 ? c.investment / c.clicks : null;
    },
    googleDetailBenchmark() {
      const m = this.googleDetailMetrics(), average = this.googleDetailCampaignCpc();
      if (!m.clicks) return { text: 'Sem cliques no período', best: false };
      if (average == null || average === 0) return { text: 'Sem média da campanha', best: false };
      const percent = (m.investment / m.clicks / average - 1) * 100;
      return { text: Math.abs(percent) < .05 ? 'Na média da campanha'
        : Math.abs(percent).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '% ' + (percent < 0 ? 'abaixo' : 'acima') + ' da média', best: percent < 0 };
    },
    googleDetailSeries() {
      const period = this.googleAdsReport?.data?.period, ad = this.googleDetailRow();
      if (!period || !ad || !Array.isArray(ad.daily)) return [];
      const days = new Map(ad.daily.map(day => [day.date, day])), rows = [];
      for (let at = Date.parse(period.since + 'T12:00:00Z'), end = Date.parse(period.until + 'T12:00:00Z'); at <= end; at += 86400000) {
        const date = new Date(at).toISOString().slice(0, 10), day = days.get(date);
        rows.push({ date, cpc: day?.clicks > 0 ? Number(day.cost_micros) / 1e6 / day.clicks : null });
      }
      return rows;
    },
    renderGoogleDetailChart() {
      if (this.marketingCampaignChannel !== 'google' || this.googleAdsView !== 'detail' || this.googleDetailTab !== 'result') return;
      const canvas = document.getElementById('chartGoogleAdDetail');
      if (!canvas || typeof Chart === 'undefined') return;
      this._googleAdDetailChart?.destroy();
      const rows = this.googleDetailSeries(), average = this.googleDetailCampaignCpc();
      const datasets = [{ label: 'Este anúncio', data: rows.map(r => r.cpc), borderColor: '#006653',
        backgroundColor: '#00665312', fill: true, pointRadius: 3, tension: .15, spanGaps: false }];
      if (average != null) datasets.push({ label: 'Média da campanha', data: rows.map(() => average),
        borderColor: '#647c9c', borderDash: [6, 5], pointRadius: 0, fill: false });
      this._googleAdDetailChart = new Chart(canvas, { type: 'line',
        data: { labels: rows.map(r => r.date), datasets },
        options: { responsive: true, maintainAspectRatio: false, animation: false,
          interaction: { mode: 'index', intersect: false },
          plugins: { legend: { display: false }, tooltip: { callbacks: {
            label: item => item.dataset.label + ': ' + this.paidMoney(item.raw),
          } } },
          scales: { x: { grid: { color: '#eef1f4' }, ticks: { maxTicksLimit: 6,
            callback: function (index) { return this.getLabelForValue(index).slice(8, 10) + '/' + this.getLabelForValue(index).slice(5, 7); } } },
            y: { beginAtZero: true, grid: { color: '#eef1f4' }, ticks: { callback: value => this.paidMoney(value) } } },
        },
      });
    },
    googleDetailDestination() {
      try {
        const url = new URL(this.googleDetailRow()?.final_url);
        return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
      } catch { return ''; }
    },
    googleDetailHost() {
      const url = this.googleDetailDestination();
      return url ? new URL(url).hostname : 'Destino não informado';
    },
    googleDetailManagerUrl() {
      const ad = this.googleDetailRow(), account = this.googleAdsReport?.data?.account?.id;
      return [account, ad?.campaign_id, ad?.ad_group_id, ad?.ad_id].every(id => /^\d+$/.test(id || ''))
        ? 'https://ads.google.com/aw/ads?customerId=' + account + '&campaignId=' + ad.campaign_id + '&adGroupId=' + ad.ad_group_id + '&adId=' + ad.ad_id : '';
    },
    googleDetailCompare() {
      const ad = this.googleDetailRow();
      const others = (this.googleAdsReport?.data?.ads || []).filter(row => row.id !== ad?.id);
      if (!ad || !others.length) return;
      const other = others.find(row => row.campaign_id === ad.campaign_id) || others[0];
      this.googleAdsSelected = [ad.id, other.id]; this.googleShowCompare();
    },
    googleDetailPipeline() {
      const r = this.googleAdsReport?.results;
      if (!r?.available || !r.ad_pipelines) return null;
      return r.ad_pipelines[this.googleAdsDetailId] || { available: true, sent: 0, pending: 0,
        processing: 0, accepted: 0, failed: 0, dead_letter: 0, review: 0, suppressed: 0 };
    },
    googleDetailPipelineCount(kind) {
      const p = this.googleDetailPipeline();
      if (!p?.available) return '—';
      return this.paidNumber(kind === 'queued' ? p.pending + p.processing + p.accepted
        : kind === 'errors' ? p.failed + p.dead_letter : p[kind]);
    },
    googleDetailEventClass(status) {
      return status === 'sent' ? 'is-sent' : ['review', 'failed', 'dead_letter'].includes(status) ? 'is-failed' : 'is-pending';
    },
    googleDetailInvalidate() {
      this.googleDetailSeq++; this.googleDetailActivity = null; this.googleDetailError = ''; this.googleDetailLoading = false;
    },
    async loadGoogleDetailActivity() {
      if (!this.googleDetailRow()) return;
      const seq = ++this.googleDetailSeq, id = this.googleAdsDetailId, period = this.marketingPeriod;
      this.googleDetailLoading = true; this.googleDetailError = ''; this.googleDetailActivity = null;
      try {
        const activity = this.marketingIsMock() ? { available: false }
          : await this.apiGet('/admin/api/marketing/google-ads/ad?ad_id=' + encodeURIComponent(id) + '&period=' + encodeURIComponent(period) + '&order_page=' + this.googleDetailOrderPage + '&conversation_page=' + this.googleDetailConversationPage);
        if (seq === this.googleDetailSeq && id === this.googleAdsDetailId && period === this.marketingPeriod) this.googleDetailActivity = activity;
      } catch {
        if (seq === this.googleDetailSeq) this.googleDetailError = 'Não foi possível consultar as conversas, vendas e envios deste anúncio.';
      } finally {
        if (seq === this.googleDetailSeq) { this.googleDetailLoading = false; this.$nextTick(() => lucide.createIcons()); }
      }
    },
    googleDetailPages(kind) {
      return Math.max(1, Math.ceil((this.googleDetailActivity?.[kind]?.total || 0) / (this.googleDetailActivity?.page_size || 25)));
    },
    googleDetailNavigate(kind, direction) {
      if (this.googleDetailLoading || !['orders', 'conversations'].includes(kind)) return;
      const key = kind === 'orders' ? 'googleDetailOrderPage' : 'googleDetailConversationPage';
      this[key] = Math.max(1, Math.min(this.googleDetailPages(kind), this[key] + direction));
      void this.loadGoogleDetailActivity();
    },
    googleDetailOrders() {
      const rows = this.googleDetailActivity?.orders?.rows || [];
      return this.googleDetailTab === 'result' ? rows.slice(0, 5) : rows;
    },
  };
};
