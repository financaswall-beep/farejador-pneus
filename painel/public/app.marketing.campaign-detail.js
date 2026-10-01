// Detalhe da campanha, dentro de Conteúdo pago. Consultas e apresentação.
window.PAINEL_MODULES.marketingCampaignDetail = function () {
  return {
    mcdTab: 'resultado', mcdAdSearch: '', mcdOrderSearch: '', mcdSelected: [], mcdEventsOpen: false, mcdAdDetailId: null,
    mcdTabs() {
      return [
        { id: 'resultado', label: 'Resultado' },
        { id: 'anuncios', label: `Anúncios (${this.marketingCampaignDetail?.ads?.length || 0})` },
        { id: 'vendas', label: 'Conversas e vendas' },
        { id: 'financeiro', label: 'Composição financeira' },
        { id: 'regioes', label: 'Regiões e ofertas' },
      ];
    },
    mcdSetTab(tab) {
      if (!this.mcdTabs().some(item => item.id === tab)) return;
      this.mcdTab = tab;
      if (tab === 'regioes') void this.loadMarketingGeography();
      this.$nextTick(() => lucide.createIcons());
    },
    async mcdPeriodChanged() {
      this.marketingCampaignDetail = null;
      this.mcdEventsOpen = false;
      this.mcdSelected = [];
      this.mcdAdDetailId = null;
      void this.loadMarketing();
      await this.loadMarketingCampaignDetail();
      if (this.mcdTab === 'regioes') void this.loadMarketingGeography();
    },
    mcdMoney(value, financial = false) {
      if (value == null) return '—';
      const currency = financial ? 'BRL' : this.marketingCampaignDetail?.campaign?.currency || 'BRL';
      return this.marketingCreativeMoney(value, currency);
    },
    mcdPercent(value) { return value == null ? '—' : `${Number(value).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`; },
    mcdKpis() {
      const d = this.marketingCampaignDetail || {}, s = d.summary || {}, f = d.financial || {};
      return [
        { id: 'investment', label: 'Investimento', value: this.mcdMoney(s.investment), icon: 'coins', note: 'Meta' },
        { id: 'conversations', label: 'Conversas na Meta', value: this.paidNumber(s.conversations_started), icon: 'message-circle', note: `${this.mcdMoney(s.cost_per_started)} por conversa` },
        { id: 'sales', label: 'Vendas atribuídas', value: this.paidNumber(f.attributed_sales), icon: 'shopping-cart', note: `Receita de ${this.mcdMoney(f.attributed_revenue, true)}` },
        { id: 'result', label: 'Resultado após mídia', value: this.mcdMoney(f.net_after_media, true), icon: 'chart-no-axes-column-increasing', note: `ROAS ${f.roas == null ? '—' : this.paidNumber(f.roas)}`, negative: f.net_after_media < 0 },
      ];
    },
    mcdIndicators() {
      const d = this.marketingCampaignDetail || {}, s = d.summary || {};
      return [
        { label: 'Impressões', value: this.paidNumber(s.impressions), icon: 'eye' },
        { label: 'Cliques', value: this.paidNumber(s.clicks), icon: 'mouse-pointer-2' },
        { label: 'CTR', value: this.mcdPercent(s.ctr), icon: 'chart-no-axes-column-increasing' },
        { label: 'Mídia por venda', value: this.mcdMoney(d.financial?.cac), icon: 'coins' },
        { label: 'Origens identificadas', value: this.paidNumber(d.quality?.ctwa_referrals), icon: 'users' },
      ];
    },
    mcdRing() {
      const value = Math.min(100, Math.max(0, this.marketingCampaignDetail?.summary?.response_rate || 0));
      return `background:conic-gradient(#00876b ${value}%,#e8f1ef 0)`;
    },
    mcdAds() {
      const search = this.mcdAdSearch.trim().toLocaleLowerCase('pt-BR');
      const ads = (this.marketingCampaignDetail?.ads || []).filter(ad =>
        `${ad.name} ${ad.adset_name || ''}`.toLocaleLowerCase('pt-BR').includes(search));
      return this.mcdTab === 'resultado' ? ads.slice(0, 3) : ads;
    },
    mcdOrders() {
      const search = this.mcdOrderSearch.trim().toLocaleLowerCase('pt-BR');
      return (this.marketingCampaignDetail?.orders || []).filter(order =>
        `${order.order_number} ${order.origin}`.toLocaleLowerCase('pt-BR').includes(search));
    },
    mcdAdDetail() { return this.marketingCampaignDetail?.ads?.find(ad => ad.id === this.mcdAdDetailId) || null; },
    mcdAdUrl() {
      const manager = this.marketingCampaignDetail?.manager_url;
      if (!manager || !this.mcdAdDetailId) return null;
      const url = new URL(manager);
      url.pathname = '/adsmanager/manage/ads';
      url.searchParams.delete('selected_campaign_ids');
      url.searchParams.set('selected_ad_ids', this.mcdAdDetailId);
      return url.toString();
    },
    mcdToggleAd(id) {
      if (this.mcdSelected.includes(id)) this.mcdSelected = this.mcdSelected.filter(value => value !== id);
      else if (this.mcdSelected.length < 2) this.mcdSelected = [...this.mcdSelected, id];
    },
    mcdCompare() {
      const d = this.marketingCampaignDetail;
      if (!d) return;
      const creatives = d.ads.map(ad => ({ ...ad, scope: d.campaign.scope, currency: d.campaign.currency,
        campaign_id: d.campaign.id, campaign_name: d.campaign.name,
        conversations: ad.conversations_started, cost_per_conversation: ad.cost_per_started }));
      void this.paidCompare(this.mcdSelected.length ? this.mcdSelected : creatives.slice(0, 2).map(ad => ad.id),
        { creatives, period: d.period });
    },
    mcdCostsLabel() {
      const q = this.marketingCampaignDetail?.quality;
      return q?.complete_cost_orders == null || q?.attributed_sales == null ? 'Indisponível'
        : `${q.complete_cost_orders} de ${q.attributed_sales}`;
    },
    mcdCostsComplete() {
      const q = this.marketingCampaignDetail?.quality;
      return q?.attributed_sales > 0 && q.complete_cost_orders === q.attributed_sales;
    },
    mcdCapiStatus() {
      const c = this.marketingCampaignDetail?.conversions;
      return !c?.available ? 'Indisponível' : c.enabled ? 'Automático' : 'Desativado';
    },
    mcdCapiCount(kind) {
      const c = this.marketingCampaignDetail?.conversions;
      return c?.available ? this.paidNumber(c[kind]) : '—';
    },
    mcdEventStatus(status) {
      return ({ sent: 'Confirmado', pending: 'Na fila', processing: 'Enviando', failed: 'Falha temporária',
        dead_letter: 'Precisa de revisão', suppressed: 'Envio suprimido' })[status] || status;
    },
    mcdRegions() {
      if (this.mgData?.period?.id !== this.marketingPeriod) return [];
      return (this.mgData?.records || []).filter(row => row.id === this.marketingCampaignDetailId);
    },
    async openMarketingCampaignDetail(row) {
      if (!row?.platform_id) return;
      this.marketingTab = 'campanhas';
      this.mcdTab = 'resultado';
      this.mcdAdSearch = '';
      this.mcdOrderSearch = '';
      this.mcdSelected = [];
      this.mcdEventsOpen = false;
      this.mcdAdDetailId = null;
      this.marketingCampaignDetailId = row.platform_id;
      this.marketingCampaignDetail = null;
      this.marketingCampaignDetailError = null;
      document.querySelector('main')?.scrollTo({ top: 0, behavior: 'smooth' });
      await this.loadMarketingCampaignDetail();
    },

    closeMarketingCampaignDetail() {
      if (this.marketingTab === 'campanhas') this.marketingTab = 'visao';
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
      const period = this.marketingPeriod;
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
        if (requestSeq === this.marketingCampaignDetailRequestSeq && period === this.marketingPeriod) {
          this.marketingCampaignDetail = payload;
          if (!payload) this.marketingCampaignDetailError = 'Sem entrega desta campanha no período selecionado.';
        }
      } catch {
        if (requestSeq === this.marketingCampaignDetailRequestSeq && period === this.marketingPeriod) {
          this.marketingCampaignDetailError = 'Não foi possível carregar o detalhe desta campanha.';
        }
      } finally {
        if (requestSeq === this.marketingCampaignDetailRequestSeq && period === this.marketingPeriod) {
          this.marketingCampaignDetailLoading = false;
          this.$nextTick(() => lucide.createIcons());
        }
      }
    },

    marketingCampaignDetailFinancialRows() {
      const financial = this.marketingCampaignDetail?.financial || {};
      const investment = this.marketingCampaignDetail?.summary?.financial_investment ?? this.marketingCampaignDetail?.summary?.investment;
      return [
        { id: 'revenue', label: 'Receita atribuída', value: financial.attributed_revenue, kind: 'positive' },
        { id: 'products', label: 'Custo dos pneus', value: financial.product_cost == null ? null : -Number(financial.product_cost), kind: 'neutral' },
        { id: 'operation', label: 'Custos, repasses e operação', value: financial.operation_cost == null ? null : -Number(financial.operation_cost), kind: 'neutral' },
        { id: 'media', label: 'Investimento em mídia', value: investment == null ? null : -Number(investment), kind: 'media' },
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
      if (minutes == null) return '—';
      const value = Number(minutes);
      if (value < 60) return `${value} min`;
      if (value < 1440) return `${Math.floor(value / 60)}h ${value % 60}min`;
      const days = Math.floor(value / 1440);
      const hours = Math.floor((value % 1440) / 60);
      return hours ? `${days}d ${hours}h` : `${days} dia(s)`;
    },

    marketingCampaignDetailDecisionClass(tone) {
      if (tone === 'critical') return 'border-rose-200 bg-rose-50 text-rose-800';
      if (tone === 'attention') return 'border-amber-200 bg-amber-50 text-amber-900';
      return 'border-emerald-200 bg-emerald-50 text-emerald-900';
    },

    marketingCampaignAttributionLabel(status) {
      const labels = {
        ready: 'Atribuição multicanal disponível',
        pending: 'Aguardando primeira venda atribuída',
        disabled: 'Atribuição multicanal desligada',
        unavailable: 'Atribuição temporariamente indisponível',
      };
      return labels[status] || 'Aguardando atribuição';
    },
  };
};
