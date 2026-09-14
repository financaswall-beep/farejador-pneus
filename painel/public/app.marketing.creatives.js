// Criativos: filtros e seleção em dados reais; amostra apenas no modo ?mock=1.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.marketingCreatives = function () {
  return {
    marketingCreativesData: null, marketingCreativesLoading: false, marketingCreativesError: '',
    marketingCreativesSeq: 0, marketingCreativeSearch: '', marketingCreativeCampaign: 'all',
    marketingCreativeFormat: 'all', marketingCreativeSort: 'cost', marketingCreativePage: 1,
    marketingCreativeSelectedId: null, marketingCreativeJourneysOpen: false,
    marketingCreativeJourneysData: null, marketingCreativeJourneysLoading: false, marketingCreativeJourneysError: '',
    marketingCreativeJourneysSeq: 0,

    async loadMarketingCreatives() {
      const seq = ++this.marketingCreativesSeq;
      const period = this.marketingPeriod;
      this.marketingCreativesLoading = true;
      this.marketingCreativesError = '';
      this.closeMarketingCreativeJourneys();
      try {
        const payload = this.marketingIsMock() ? marketingCreativeMockPayload(period)
          : await this.apiGet(`/admin/api/marketing/creatives?period=${encodeURIComponent(period)}`);
        if (seq !== this.marketingCreativesSeq || period !== this.marketingPeriod) return;
        this.marketingCreativesData = payload;
        if (!this.marketingCreativeCampaigns().some((row) => row.id === this.marketingCreativeCampaign)) this.marketingCreativeCampaign = 'all';
        this.marketingCreativePage = 1;
        this.marketingCreativeReconcile();
      } catch {
        if (seq === this.marketingCreativesSeq) {
          this.marketingCreativesData = null;
          this.marketingCreativesError = 'Não foi possível carregar os criativos. Tente novamente.';
        }
      } finally {
        if (seq === this.marketingCreativesSeq) {
          this.marketingCreativesLoading = false;
          this.$nextTick(() => { lucide.createIcons(); this.renderMarketingCreativeChart(); });
        }
      }
    },
    marketingCreativeCampaigns() {
      return [...new Map((this.marketingCreativesData?.creatives || []).map((row) =>
        [row.campaign_id, { id: row.campaign_id, name: row.campaign_name }])).values()];
    },
    marketingCreativeFiltered() {
      const query = this.marketingCreativeSearch.trim().toLocaleLowerCase('pt-BR');
      const rows = (this.marketingCreativesData?.creatives || []).filter((row) =>
        (this.marketingCreativeCampaign === 'all' || row.campaign_id === this.marketingCreativeCampaign)
        && (this.marketingCreativeFormat === 'all' || (row.media?.format || 'unknown') === this.marketingCreativeFormat)
        && (!query || `${row.name} ${row.campaign_name}`.toLocaleLowerCase('pt-BR').includes(query)));
      return rows.sort((a, b) => {
        const value = this.marketingCreativeSort === 'cost'
          ? (a.cost_per_conversation ?? Infinity) - (b.cost_per_conversation ?? Infinity)
          : this.marketingCreativeSort === 'sales' ? (b.attributed_sales ?? -1) - (a.attributed_sales ?? -1)
          : this.marketingCreativeSort === 'investment' ? b.investment - a.investment : b.conversations - a.conversations;
        return value || a.name.localeCompare(b.name, 'pt-BR');
      });
    },
    marketingCreativePageCount() { return Math.max(1, Math.ceil(this.marketingCreativeFiltered().length / 3)); },
    marketingCreativePageRows() { return this.marketingCreativeFiltered().slice((this.marketingCreativePage - 1) * 3, this.marketingCreativePage * 3); },
    marketingCreativeSelected() {
      return this.marketingCreativeFiltered().find((row) => row.id === this.marketingCreativeSelectedId) || null;
    },
    marketingCreativeReconcile() {
      const rows = this.marketingCreativePageRows();
      if (!rows.some((row) => row.id === this.marketingCreativeSelectedId)) this.marketingCreativeSelectedId = rows[0]?.id || null;
      this.$nextTick(() => { lucide.createIcons(); this.renderMarketingCreativeChart(); });
    },
    marketingCreativeFiltersChanged() { this.marketingCreativePage = 1; this.marketingCreativeReconcile(); },
    marketingCreativeSetPage(page) {
      this.marketingCreativePage = Math.min(Math.max(1, page), this.marketingCreativePageCount());
      this.marketingCreativeReconcile();
    },
    marketingCreativeSelect(row) {
      this.marketingCreativeSelectedId = row.id;
      this.$nextTick(() => { lucide.createIcons(); this.renderMarketingCreativeChart(); });
    },
    marketingCreativeSetPeriod(period) {
      if (this.marketingPeriod === period) return;
      this.marketingPeriod = period;
      this.marketingPeriodChanged();
    },
    marketingCreativeMetrics() {
      const rows = this.marketingCreativeFiltered();
      const currencies = new Set(rows.map((row) => row.currency));
      const spend = rows.reduce((sum, row) => sum + row.investment, 0);
      const conversations = rows.reduce((sum, row) => sum + row.conversations, 0);
      return { count: rows.length, investment: currencies.size > 1 ? null : spend, conversations,
        currency: rows[0]?.currency || 'BRL', cost: conversations > 0 && currencies.size <= 1 ? spend / conversations : null };
    },
    marketingCreativeMoney(value, currency = 'BRL') {
      if (value == null) return '—';
      try { return Number(value).toLocaleString('pt-BR', { style: 'currency', currency }); }
      catch { return `${Number(value).toFixed(2)} ${currency}`; }
    },
    marketingCreativeFormatLabel(format) {
      return ({ image: 'Imagem', video: 'Vídeo', carousel: 'Carrossel', mixed: 'Múltiplas mídias' })[format] || 'Formato indisponível';
    },
    marketingCreativeStatusLabel(row) {
      return ({ ACTIVE: 'Ativo', PAUSED: 'Pausado', CAMPAIGN_PAUSED: 'Campanha pausada', ADSET_PAUSED: 'Conjunto pausado',
        ARCHIVED: 'Arquivado', DELETED: 'Excluído', DISAPPROVED: 'Reprovado', PENDING_REVIEW: 'Em análise', WITH_ISSUES: 'Com pendências' })[row.media?.status] || 'Status indisponível';
    },
    marketingCreativeAttributionNote(row) {
      return ({ disabled: 'Atribuição ainda não habilitada.', unavailable: 'Não foi possível consultar a atribuição.',
        pending: 'Aguardando uma conversa vinculada a este anúncio.', scope_pending: 'A campanha precisa estar classificada como Matriz para exibir vendas.' })[row?.attribution_status] || '';
    },
    marketingCreativeComparison(row) {
      const average = this.marketingCreativeMetrics().cost;
      if (row?.cost_per_conversation == null || !average) return 'Comparação indisponível';
      const delta = (row.cost_per_conversation / average - 1) * 100;
      return Math.abs(delta) < 0.1 ? 'Na média dos filtros' : `${Math.abs(delta).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% ${delta < 0 ? 'abaixo' : 'acima'} da média dos filtros`;
    },
    marketingCreativeBestCost(row) {
      const rows = this.marketingCreativeFiltered().filter((item) => item.currency === row.currency && item.cost_per_conversation != null);
      return rows.length > 1 && row.cost_per_conversation != null && row.cost_per_conversation === Math.min(...rows.map((item) => item.cost_per_conversation));
    },
    marketingCreativeRange() {
      const period = this.marketingCreativesData?.period;
      return period ? `${this.marketingDateLabel(period.since)} — ${this.marketingDateLabel(period.until)}` : 'Carregando período…';
    },
    async openMarketingCreativeJourneys(row) {
      window._mcLastFocus = document.activeElement;
      const seq = ++this.marketingCreativeJourneysSeq;
      this.marketingCreativeJourneysOpen = true; this.marketingCreativeJourneysLoading = true;
      this.marketingCreativeJourneysError = ''; this.marketingCreativeJourneysData = null;
      this.$nextTick(() => document.querySelector('.mc-dialog button')?.focus());
      try {
        const payload = this.marketingIsMock() ? { name: row.name, rows: [] }
          : await this.apiGet(`/admin/api/marketing/creatives/${encodeURIComponent(row.id)}/journeys?period=${encodeURIComponent(this.marketingPeriod)}`);
        if (seq === this.marketingCreativeJourneysSeq) this.marketingCreativeJourneysData = payload;
      } catch {
        if (seq === this.marketingCreativeJourneysSeq) this.marketingCreativeJourneysError = 'Não foi possível carregar as jornadas deste anúncio.';
      } finally { if (seq === this.marketingCreativeJourneysSeq) this.marketingCreativeJourneysLoading = false; }
    },
    closeMarketingCreativeJourneys() {
      if (this.marketingCreativeJourneysOpen) window._mcLastFocus?.focus();
      this.marketingCreativeJourneysOpen = false; ++this.marketingCreativeJourneysSeq;
    },
    marketingCreativeDialogTab(event) {
      const nodes = [...event.currentTarget.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled)')].filter((node) => node.getClientRects().length);
      if (!nodes.length) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1).focus(); }
      else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0].focus(); }
    },
    exportMarketingCreatives() {
      const rows = this.marketingCreativeFiltered();
      if (!rows.length) return;
      const period = this.marketingCreativesData.period;
      const cell = (value) => { const s = String(value ?? ''); return `"${(/^[=+\-@\t\r]/.test(s) ? "'" + s : s).replace(/"/g, '""')}"`; };
      const lines = [['De', 'Até', 'Anúncio', 'Campanha', 'Formato', 'Status', 'Moeda', 'Investimento', 'Conversas Meta', 'Custo por conversa', 'Conversas identificadas', 'Vendas atribuídas', 'Receita atribuída', 'Atribuição'],
        ...rows.map((row) => [period.since, period.until, row.name, row.campaign_name, this.marketingCreativeFormatLabel(row.media?.format), this.marketingCreativeStatusLabel(row), row.currency,
          row.investment, row.conversations, row.cost_per_conversation, row.tracked, row.attributed_sales, row.attributed_revenue, row.attribution_status])];
      const url = URL.createObjectURL(new Blob(['\uFEFF' + lines.map((line) => line.map(cell).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url; link.download = `criativos-${period.since}-${period.until}.csv`;
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  };
};
