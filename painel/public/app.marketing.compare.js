// Comparação de anúncios: navegação e leitura dos mesmos endpoints da galeria e do detalhe.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.marketingCompare = function () {
  let trigger = null, originAd = null;
  return {
    paidCompareOpen: false, paidCompareIds: [], paidCompareData: null,
    pcScope: 'matrix', pcLoading: false, pcError: '', pcSeq: 0,
    pcDetails: {}, pcDetailErrors: {}, pcDetailsLoading: false, pcDetailSeq: 0,
    pcBackLabel: 'Conteúdo pago', pcSelectionNotice: '',
    async paidCompare(selectedIds = null, data = null) {
      trigger = document.activeElement;
      originAd = this.madId ? { id: this.madId, origin: this.madOrigin } : null;
      this.pcBackLabel = originAd ? 'Voltar ao anúncio' : this.marketingTab === 'campanhas'
        ? 'Voltar à campanha' : this.marketingTab === 'criativos' ? 'Todos os anúncios' : 'Conteúdo pago';
      this.pcScope = this.madData?.ad?.scope || (this.marketingTab === 'criativos'
        ? this.marketingCreativeScope : this.marketingTab === 'campanhas'
          ? this.marketingCampaignDetail?.campaign?.scope : this.paidScope) || 'matrix';
      if (originAd) this.madClose(false);
      this.paidCompareOpen = true;
      this.pcSelectionNotice = '';
      this.paidCompareData = null;
      this.paidCompareIds = Array.isArray(selectedIds) ? [...new Set(selectedIds)].slice(0, 2) : [];
      if (data?.period?.id) this.marketingPeriod = data.period.id;
      document.querySelector('main')?.scrollTo({ top: 0 });
      this.$nextTick(() => document.getElementById('paid-compare-heading')?.focus({ preventScroll: true }));
      await this.pcLoad();
    },
    paidCloseCompare(restore = true) {
      ++this.pcSeq; ++this.pcDetailSeq;
      this.paidCompareOpen = false;
      this.pcLoading = false; this.pcDetailsLoading = false;
      this.pcDestroyChart();
      const previous = originAd; originAd = null;
      if (restore && previous) void this.madOpen({ id: previous.id }, previous.origin);
      else this.$nextTick(() => { if (restore) trigger?.focus(); lucide.createIcons(); });
    },
    async pcLoad() {
      const seq = ++this.pcSeq, period = this.marketingPeriod;
      ++this.pcDetailSeq;
      this.pcLoading = true; this.pcError = ''; this.pcDetails = {}; this.pcDetailErrors = {};
      this.pcDetailsLoading = false; this.paidCompareData = null;
      this.pcDestroyChart();
      try {
        const data = this.marketingIsMock() ? marketingCreativeMockPayload(period)
          : await this.apiGet(`/admin/api/marketing/creatives?period=${encodeURIComponent(period)}`);
        if (seq !== this.pcSeq || !this.paidCompareOpen || period !== this.marketingPeriod) return;
        if (!data?.available) throw Error('not_configured');
        this.paidCompareData = data;
        this.pcReconcile();
      } catch (error) {
        if (seq !== this.pcSeq) return;
        this.pcError = error?.message === 'not_configured'
          ? 'Configure a conta da Meta em Integrações para comparar anúncios.'
          : 'Não foi possível carregar os anúncios para comparação. Tente novamente.';
      } finally {
        if (seq === this.pcSeq) {
          this.pcLoading = false;
          this.$nextTick(() => lucide.createIcons());
        }
      }
      if (seq === this.pcSeq && this.paidCompareData && this.paidCompareOpen) await this.pcLoadDetails();
    },
    pcPeriodChanged() {
      this.pcSelectionNotice = '';
      void this.loadMarketing();
      if (this.marketingTab === 'criativos') void this.loadMarketingCreatives();
      if (this.marketingCampaignDetailId) void this.loadMarketingCampaignDetail();
      return this.pcLoad();
    },
    paidCompareOptions() {
      return (this.paidCompareData?.creatives || []).filter(ad => this.pcScope === 'all' || ad.scope === this.pcScope);
    },
    pcReconcile() {
      const rows = this.paidCompareOptions(), old = this.paidCompareIds;
      const kept = [...new Set(old)].filter(id => rows.some(row => row.id === id)).slice(0, 2);
      if (old.some(id => !kept.includes(id))) this.pcSelectionNotice = 'A seleção foi ajustada aos anúncios disponíveis neste período e escopo.';
      for (const row of rows) { if (kept.length === 2) break; if (!kept.includes(row.id)) kept.push(row.id); }
      this.paidCompareIds = kept;
    },
    pcScopeChanged() {
      this.pcSelectionNotice = '';
      this.pcReconcile();
      return this.pcLoadDetails();
    },
    pcSelect(side, id) {
      if (![0, 1].includes(side) || !this.paidCompareOptions().some(row => row.id === id)) return;
      if (this.paidCompareIds[side] === id) return;
      if (this.paidCompareIds[1 - side] === id) return this.pcSwap();
      const ids = [...this.paidCompareIds]; ids[side] = id;
      this.paidCompareIds = ids;
      this.pcSelectionNotice = '';
      return this.pcLoadDetails();
    },
    pcSwap() {
      if (this.paidCompareIds.length < 2) return;
      this.paidCompareIds = [...this.paidCompareIds].reverse();
      this.$nextTick(() => this.pcRenderChart());
    },
    async pcLoadDetails() {
      const seq = ++this.pcDetailSeq, period = this.marketingPeriod, ids = [...this.paidCompareIds];
      this.pcDetails = {}; this.pcDetailErrors = {};
      this.pcDetailsLoading = ids.length > 0;
      this.$nextTick(() => this.pcRenderChart());
      const results = await Promise.allSettled(ids.map(id => this.marketingIsMock()
        ? Promise.resolve(marketingAdDetailMock(id, period))
        : this.apiGet(`/admin/api/marketing/creatives/${encodeURIComponent(id)}/detail?period=${encodeURIComponent(period)}`)));
      if (seq !== this.pcDetailSeq || !this.paidCompareOpen || period !== this.marketingPeriod) return;
      const details = {}, errors = {};
      results.forEach((result, index) => {
        const id = ids[index], data = result.status === 'fulfilled' ? result.value : null;
        if (data?.available && data.ad?.id === id && data.period?.id === period
          && data.period.since === this.paidCompareData?.period?.since && data.period.until === this.paidCompareData?.period?.until) details[id] = data;
        else errors[id] = 'Não foi possível conferir a composição dos custos deste anúncio.';
      });
      this.pcDetails = details; this.pcDetailErrors = errors; this.pcDetailsLoading = false;
      this.$nextTick(() => { lucide.createIcons(); this.pcRenderChart(); });
    },
    pcAd(side) {
      const id = this.paidCompareIds[side];
      if (this.pcLoading || this.pcError) return null;
      return this.pcDetails[id]?.ad || this.paidCompareOptions().find(row => row.id === id) || null;
    },
    paidCompared() { return [this.pcAd(0), this.pcAd(1)].filter(Boolean); },
    paidCompareRange() {
      const period = this.paidCompareData?.period;
      return period ? `${this.marketingDateLabel(period.since)} — ${this.marketingDateLabel(period.until)}` : 'Carregando período…';
    },
    pcEmptyMessage() {
      const scope = { matrix: 'da 2W/Matriz', external: 'externo', pending: 'com escopo pendente', all: '' }[this.pcScope];
      return `Nenhum anúncio ${scope || ''} neste período. Altere o período ou o escopo.`;
    },
    pcViewAd(side) {
      const ad = this.pcAd(side);
      if (!ad) return;
      this.pcDestroyChart();
      void this.madOpen(ad, 'compare');
    },
  };
};
