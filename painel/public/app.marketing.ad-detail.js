// Detalhe de um anúncio dentro de Conteúdo pago. O servidor fornece os mesmos resultados da galeria.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.marketingAdDetail = function () {
  let trigger = null;
  return {
    madId: null, madData: null, madLoading: false, madError: '', madSeq: 0,
    madOrigin: 'ads', madTab: 'resultado', madSearch: '', madEventFilter: 'all', madCalculation: false,
    madOrderId: null,
    async madOpen(row, origin = 'ads') {
      if (!row?.id) return;
      trigger = document.activeElement;
      this.madId = row.id;
      this.madOrigin = origin;
      this.madTab = 'resultado';
      this.madSearch = '';
      this.madEventFilter = 'all';
      this.madCalculation = false;
      this.madOrderId = null;
      this.madData = null;
      this.marketingCreativeAnalysisOpen = false;
      this.closeMarketingCreativeJourneys();
      document.querySelector('main')?.scrollTo({ top: 0 });
      await this.madLoad();
      this.$nextTick(() => document.getElementById('marketing-ad-heading')?.focus({ preventScroll: true }));
    },
    madClose(restore = true) {
      ++this.madSeq;
      this.madId = null;
      this.madData = null;
      this.madLoading = false;
      this.madError = '';
      this.destroyMarketingCreativeChart();
      this.$nextTick(() => {
        lucide.createIcons();
        if (this.paidCompareOpen) this.pcRenderChart();
        if (restore) trigger?.focus();
      });
    },
    async madLoad() {
      if (!this.madId) return;
      const seq = ++this.madSeq, id = this.madId, period = this.marketingPeriod;
      this.madLoading = true;
      this.madError = '';
      this.destroyMarketingCreativeChart();
      try {
        const data = this.marketingIsMock() ? marketingAdDetailMock(id, period)
          : await this.apiGet(`/admin/api/marketing/creatives/${encodeURIComponent(id)}/detail?period=${encodeURIComponent(period)}`);
        if (seq !== this.madSeq || id !== this.madId || period !== this.marketingPeriod) return;
        if (!data?.available) throw new Error('unavailable');
        this.madData = data;
      } catch (error) {
        if (seq !== this.madSeq) return;
        this.madData = null;
        this.madError = String(error?.message || '').includes('creative_not_found')
          ? 'Este anúncio não tem entrega no período selecionado.' : 'Não foi possível carregar este anúncio. Tente novamente.';
      } finally {
        if (seq === this.madSeq) {
          this.madLoading = false;
          this.$nextTick(() => { lucide.createIcons(); this.renderMarketingCreativeChart(); });
        }
      }
    },
    madPeriodChanged() {
      this.madData = null;
      this.madOrderId = null;
      void this.madLoad();
      void this.loadMarketing();
      if (this.paidCompareOpen) void this.pcLoad();
      if (this.madOrigin === 'campaign') void this.loadMarketingCampaignDetail();
      else void this.loadMarketingCreatives();
    },
    madSetTab(tab) {
      if (!['resultado', 'vendas', 'envios'].includes(tab)) return;
      this.madTab = tab;
      this.$nextTick(() => { lucide.createIcons(); this.renderMarketingCreativeChart(); });
    },
    madOpenCampaign() {
      const campaign = this.madData?.campaign;
      if (!campaign) return;
      this.madClose(false);
      if (this.paidCompareOpen) this.paidCloseCompare(false);
      void this.openMarketingCampaignDetail({ platform_id: campaign.id });
    },
    madMoney(value, media = false) {
      return this.marketingCreativeMoney(value, media ? this.madData?.ad?.currency || 'BRL' : 'BRL');
    },
    madNumber(value) {
      return value == null ? '—' : Number(value).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
    },
    madDelivery() {
      const ad = this.madData?.ad || {};
      return [
        { label: 'Investimento', value: this.madMoney(ad.investment, true) },
        { label: 'Impressões', value: this.madNumber(ad.impressions) },
        { label: 'Cliques', value: this.madNumber(ad.clicks) },
        { label: 'CTR', value: ad.impressions > 0 ? this.madNumber(ad.clicks / ad.impressions * 100) + '%' : '—' },
        { label: 'Conversas iniciadas', value: this.madNumber(ad.conversations) },
        { label: 'Custo por conversa', value: this.madMoney(ad.cost_per_conversation, true) },
        { label: 'CPC', value: this.madMoney(ad.clicks > 0 ? ad.investment / ad.clicks : null, true) },
        { label: 'CPM', value: this.madMoney(ad.impressions > 0 ? ad.investment / ad.impressions * 1000 : null, true) },
      ];
    },
    madSalesMetrics() {
      const ad = this.madData?.ad || {}, f = this.madData?.financial || {};
      return [
        { label: 'Conversas identificadas', value: this.madNumber(ad.tracked) },
        { label: 'Vendas atribuídas', value: this.madNumber(ad.attributed_sales) },
        { label: 'Receita atribuída', value: this.madMoney(ad.attributed_revenue) },
        { label: 'Custo dos pneus', value: this.madMoney(f.product_cost) },
        { label: 'Resultado após mídia', value: this.madMoney(ad.net_after_media), result: true, negative: ad.net_after_media < 0 },
        { label: 'ROAS', value: this.madNumber(f.roas) },
      ];
    },
    madComparison() {
      const average = this.madData?.campaign?.cost_per_conversation, value = this.madData?.ad?.cost_per_conversation;
      if (average == null || average <= 0 || value == null) return 'Comparação indisponível';
      const delta = (value / average - 1) * 100;
      return Math.abs(delta) < .1 ? 'Na média da campanha'
        : `${this.madNumber(Math.abs(delta))}% ${delta < 0 ? 'abaixo' : 'acima'} da média da campanha`;
    },
    madCompare() {
      if (this.paidCompareOpen) { this.madClose(); return; }
      const data = this.madData;
      if (!data) return;
      const ids = [data.ad.id, ...data.peers.filter(ad => ad.id !== data.ad.id).slice(0, 1).map(ad => ad.id)];
      void this.paidCompare(ids, { creatives: data.peers, period: data.period });
    },
    madOrders() {
      const query = this.madSearch.trim().toLocaleLowerCase('pt-BR');
      const rows = (this.madData?.orders?.rows || []).filter(row =>
        `${row.order_number} ${row.conversation_id} ${row.channel}`.toLocaleLowerCase('pt-BR').includes(query));
      return this.madTab === 'resultado' ? rows.slice(0, 5) : rows;
    },
    madJourneys() {
      const query = this.madSearch.trim().toLocaleLowerCase('pt-BR');
      return (this.madData?.journeys?.rows || []).filter(row =>
        `${row.conversation_id} ${(row.channels || []).join(' ')}`.toLocaleLowerCase('pt-BR').includes(query));
    },
    madEvents() {
      return (this.madData?.conversions?.events || []).filter(row => this.madEventFilter === 'all'
        || (this.madEventFilter === 'pending' ? ['pending', 'processing'].includes(row.status)
          : this.madEventFilter === 'failed' ? ['failed', 'dead_letter'].includes(row.status) : row.status === this.madEventFilter));
    },
    madCapiCount(kind) { return this.madData?.conversions?.available ? this.madNumber(this.madData.conversions[kind]) : '—'; },
    madCapiLabel() {
      const capi = this.madData?.conversions;
      return !capi?.available ? 'Indisponível' : capi.enabled ? 'Automático' : 'Desativado';
    },
    madStatus(status) { return status ? this.mcdEventStatus(status) : 'Sem envio registrado'; },
    madChatUrl(row) {
      const base = this.madData?.chatwoot_base;
      if (!base || !/^\d+$/.test(String(row?.account_id)) || !/^\d+$/.test(String(row?.conversation_id))) return null;
      return `${base}/app/accounts/${row.account_id}/conversations/${row.conversation_id}`;
    },
    madOrder() { return this.madData?.orders?.rows?.find(row => row.id === this.madOrderId) || null; },
    madFinancialRows() {
      const d = this.madData, f = d?.financial, ad = d?.ad;
      return [
        { label: 'Receita atribuída', value: ad?.attributed_revenue },
        { label: 'Custo dos pneus', value: f?.product_cost == null ? null : -f.product_cost },
        { label: 'Repasses e operação', value: f?.operation_cost == null ? null : -f.operation_cost },
        { label: 'Investimento em mídia', value: ad?.currency === 'BRL' ? -ad.investment : null },
        { label: 'Resultado após mídia', value: ad?.net_after_media },
      ];
    },
  };
};
