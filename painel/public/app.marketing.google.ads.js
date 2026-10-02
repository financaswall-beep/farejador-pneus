// Galeria Google: métricas do filtro e apuração do mesmo motor usado na visão geral.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.marketingGoogleAds = function () {
  return {
    googleAdStatus: '', googleAdFormat: '', googleAdSort: 'cpc', googleAdPage: 1,
    googleAdLayout: 'grid', googleAdPageSize: 3, googleAdBrokenImages: {},
    googleAdFormatLabel(format) {
      return { RESPONSIVE_SEARCH_AD: 'Pesquisa', EXPANDED_TEXT_AD: 'Pesquisa', TEXT_AD: 'Pesquisa',
        RESPONSIVE_DISPLAY_AD: 'Display responsivo', IMAGE_AD: 'Imagem', VIDEO_AD: 'Vídeo',
        VIDEO_RESPONSIVE_AD: 'Vídeo responsivo', SHOPPING_PRODUCT_AD: 'Shopping',
        DEMAND_GEN_MULTI_ASSET_AD: 'Geração de demanda', DEMAND_GEN_VIDEO_RESPONSIVE_AD: 'Geração de demanda · vídeo',
        APP_AD: 'Aplicativo' }[format] || 'Outro formato';
    },
    googleAdFormats() {
      return [...new Set((this.googleAdsReport?.data?.ads || []).map(ad => ad.format))]
        .map(id => ({ id, label: this.googleAdFormatLabel(id) })).sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
    },
    googleAdRows() {
      const query = this.googleAdsSearch.trim().toLocaleLowerCase('pt-BR');
      const rows = (this.googleAdsReport?.data?.ads || []).filter(ad =>
        (!this.googleAdsCampaign || ad.campaign_id === this.googleAdsCampaign)
        && (!this.googleAdStatus || ad.status === this.googleAdStatus)
        && (!this.googleAdFormat || ad.format === this.googleAdFormat)
        && (!query || [ad.name, ad.campaign_name, ad.ad_id, ...(ad.headlines || []), ...(ad.descriptions || [])]
          .join(' ').toLocaleLowerCase('pt-BR').includes(query)));
      const key = this.googleAdSort, ascending = key === 'cpc' || key === 'name';
      return rows.map(ad => ({ ...ad, ...this.googleResult(ad) })).sort((a, b) => {
        if (key === 'name') return a.name.localeCompare(b.name, 'pt-BR') || a.id.localeCompare(b.id);
        if (a[key] == null || b[key] == null) return a[key] == null ? (b[key] == null ? a.id.localeCompare(b.id) : 1) : -1;
        return (ascending ? a[key] - b[key] : b[key] - a[key]) || a.id.localeCompare(b.id);
      });
    },
    googleAdPages() { return Math.max(1, Math.ceil(this.googleAdRows().length / this.googleAdPageSize)); },
    googleAdCurrentPage() { return Math.min(Math.max(1, this.googleAdPage), this.googleAdPages()); },
    googleAdPageRows() {
      const start = (this.googleAdCurrentPage() - 1) * this.googleAdPageSize;
      return this.googleAdRows().slice(start, start + this.googleAdPageSize);
    },
    googleAdNavigatePage(direction) {
      this.googleAdPage = Math.min(this.googleAdPages(), Math.max(1, this.googleAdCurrentPage() + direction));
      this.$nextTick(() => { lucide.createIcons(); document.querySelector('[data-google-ad-gallery]')?.scrollIntoView({ block: 'start' }); });
    },
    googleAdSummary() {
      const rows = this.googleAdRows(), sum = key => rows.reduce((total, ad) => total + Number(ad[key] || 0), 0);
      const money = n => Math.round((n + Number.EPSILON) * 100) / 100;
      const investment = money(sum('investment')), clicks = sum('clicks'), impressions = sum('impressions');
      const available = this.googleAdsReport?.results?.available === true;
      const revenue = available ? money(sum('attributed_revenue')) : null;
      return { count: rows.length, investment, clicks, impressions, conversions: sum('conversions'),
        cpc: clicks ? money(investment / clicks) : null, ctr: impressions ? money(clicks / impressions * 100) : null,
        sales: available ? sum('attributed_sales') : null, revenue,
        result: available && rows.every(ad => ad.result != null) ? money(sum('result')) : null,
        roas: investment && revenue != null ? money(revenue / investment) : null };
    },
    googleAdSummaryItems() {
      const m = this.googleAdSummary();
      return [{ label: 'Anúncios no filtro', value: this.paidNumber(m.count) },
        { label: 'Investimento', value: this.paidMoney(m.investment) },
        { label: 'Cliques', value: this.paidNumber(m.clicks) },
        { label: 'Custo por clique', value: this.paidMoney(m.cpc) },
        { label: 'Vendas atribuídas', value: this.paidNumber(m.sales) },
        { label: 'Resultado após mídia', value: this.paidMoney(m.result), result: true, negative: m.result < 0 }];
    },
    googleAdIndicators() {
      const m = this.googleAdSummary();
      return [{ label: 'Impressões', value: this.paidNumber(m.impressions), icon: 'eye' },
        { label: 'CTR', value: m.ctr == null ? '—' : this.paidNumber(m.ctr) + '%', icon: 'chart-no-axes-column' },
        { label: 'Conversões Google', value: this.paidNumber(m.conversions), icon: 'mouse-pointer-2' },
        { label: 'ROAS', value: this.paidNumber(m.roas), icon: 'trending-up' }];
    },
    googleAdCardItems(ad) {
      return [{ label: 'Investimento', value: this.paidMoney(ad.investment) },
        { label: 'Cliques', value: this.paidNumber(ad.clicks) }, { label: 'Custo / clique', value: this.paidMoney(ad.cpc) },
        { label: 'Vendas atribuídas', value: this.paidNumber(ad.attributed_sales) },
        { label: 'Receita', value: this.paidMoney(ad.attributed_revenue) },
        { label: 'Resultado após mídia', value: this.paidMoney(ad.result), result: true, negative: ad.result < 0 }];
    },
    googleAdCostBadge(ad) {
      const eligible = this.googleAdRows().filter(row => row.clicks > 0 && row.cpc != null);
      if (!ad.clicks || ad.cpc == null) return { text: 'Sem cliques no período', best: false };
      if (eligible.length < 2) return { text: 'Sem comparação no filtro', best: false };
      const average = this.googleAdSummary().cpc;
      if (!average) return { text: 'Sem custo de mídia', best: false };
      const percent = Math.round((ad.cpc / average - 1) * 1000) / 10;
      return { text: Math.abs(percent) < .1 ? 'Na média dos filtros'
        : this.paidNumber(Math.abs(percent)) + '% ' + (percent < 0 ? 'abaixo' : 'acima') + ' da média', best: percent < 0 };
    },
    googleAdIsSearch(ad) { return ['RESPONSIVE_SEARCH_AD', 'EXPANDED_TEXT_AD', 'TEXT_AD'].includes(ad.format); },
    googleAdImage(ad) {
      if (!ad || this.googleAdIsSearch(ad) || this.googleAdBrokenImages[ad.id] === ad.image_url) return '';
      try { const url = new URL(ad.image_url); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; }
      catch { return ''; }
    },
    googleAdImageFailed(ad) { this.googleAdBrokenImages = { ...this.googleAdBrokenImages, [ad.id]: ad.image_url }; },
    googleAdPreviewTitle(ad) { return (ad.headlines || []).slice(0, 2).join(' · ') || ad.name; },
    googleAdPreviewDescription(ad) { return (ad.descriptions || []).slice(0, 2).join(' '); },
    googleAdPreviewBrand(ad) {
      if (ad.business_name) return ad.business_name;
      try { return new URL(ad.final_url).hostname; } catch { return this.googleAdsReport?.data?.account?.name || 'Google Ads'; }
    },
    googleAdSelectedRows() { return this.googleAdsSelected.map(id => this.googleAdById(id)).filter(Boolean); },
    googleAdExport() {
      const rows = this.googleAdRows();
      if (!rows.length) return;
      this.googleExportCells([['ID anúncio', 'ID grupo', 'Campanha', 'Anúncio', 'Status', 'Formato', 'Investimento BRL',
        'Impressões', 'Cliques', 'CTR %', 'CPC BRL', 'Conversões Google', 'Conversas identificadas', 'Vendas atribuídas',
        'Receita BRL', 'Resultado após mídia BRL'], ...rows.map(ad => [ad.ad_id, ad.ad_group_id, ad.campaign_name,
        ad.name, this.googleAdsStatus(ad.status), this.googleAdFormatLabel(ad.format), ad.investment, ad.impressions,
        ad.clicks, ad.ctr, ad.cpc, ad.conversions, ad.tracked_conversations, ad.attributed_sales, ad.attributed_revenue, ad.result])]);
    },
  };
};
