window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.resumo = function () {
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone:'America/Sao_Paulo' }).format(new Date());
  return {
    overview: null, overviewLoading: false, overviewError: '', overviewRequest: 0,
    overviewPeriod: 'month', overviewMonth: today().slice(0,7), overviewMaxMonth: today().slice(0,7),
    async loadMatrizOverview({ silent = false } = {}) {
      if (!this.adminAuthenticated || !this.isMatrixPanel() || !this.hasPanelModule('resumo')) return;
      if (silent && this.overviewLoading) return;
      const request = ++this.overviewRequest;
      this.overviewLoading = true;
      try {
        const query = new URLSearchParams({ period:this.overviewPeriod, month:this.overviewMonth });
        const data = await this.apiGet('/admin/api/dashboard/matriz-overview?' + query);
        if (request !== this.overviewRequest) return;
        this.overview = data;
        this.overviewError = '';
        this.chatwootBaseUrl = data.chatwoot_base_url || this.chatwootBaseUrl;
        this.chatwootAccountId = data.chatwoot_account_id || this.chatwootAccountId;
        this.$nextTick(() => { window.lucide?.createIcons(); this.renderOverviewChart(); });
      } catch (_) {
        if (request !== this.overviewRequest) return;
        this.overviewError = this.overview
          ? 'Não consegui atualizar. Os dados abaixo são da última consulta.'
          : 'Não foi possível carregar o Resumo. Tente novamente.';
      } finally { if (request === this.overviewRequest) this.overviewLoading = false; }
    },
    overviewSetPeriod(period) {
      this.overviewPeriod = period;
      if (period !== 'month') this.overviewMonth = today().slice(0,7);
      this.overviewFilterChanged();
    },
    overviewFilterChanged() {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(this.overviewMonth) || this.overviewMonth > today().slice(0,7)) {
        this.overviewMonth = today().slice(0,7);
      }
      this.overview = null;
      this.overviewError = '';
      window._overviewChart?.destroy(); window._overviewChart = null;
      void this.loadMatrizOverview();
    },
    overviewMoney(cents) {
      return cents == null ? '—' : new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(cents/100);
    },
    overviewNumber(value) { return value == null ? '—' : Number(value).toLocaleString('pt-BR'); },
    overviewMonthLabel(month) {
      return new Date((month || this.overviewMonth)+'-01T12:00:00Z').toLocaleDateString('pt-BR',{month:'long',year:'numeric',timeZone:'America/Sao_Paulo'});
    },
    overviewDate(date) { return date ? new Date(date+'T12:00:00Z').toLocaleDateString('pt-BR',{day:'2-digit',month:'short',timeZone:'America/Sao_Paulo'}) : ''; },
    overviewRange() {
      const range = this.overview?.period;
      return range ? `${this.overviewDate(range.from)} a ${this.overviewDate(range.to)}` : 'Consultando período…';
    },
    overviewResult() {
      const finance=this.overview?.finance;
      return !finance ? '—' : finance.status !== 'confirmado' ? 'Em conferência' : this.overviewMoney(finance.result_cents);
    },
    overviewResultDetail() {
      const finance=this.overview?.finance;
      if (!finance) return 'Consulte a disponibilidade no Financeiro';
      if (finance.status==='custo_pendente') return 'Há pneus vendidos com custo pendente';
      if (finance.status!=='confirmado') return 'Há valores que precisam de conciliação';
      return 'Após custos e despesas registrados';
    },
    overviewTiresDetail() {
      const s=this.overview?.sales?.summary;
      if (!s) return 'Moto, carro e lotes';
      return `${s.moto} moto · ${s.car} carro · ${s.lots} em lotes`+(s.unclassified?` · ${s.unclassified} sem classificação`:'');
    },
    overviewAttention() {
      const a=this.overview?.attention;
      return [
        {key:'human',icon:'user-round',label:'Conversas com atendimento humano',page:'bot',tone:'orange'},
        {key:'pickups',icon:'store',label:'Retiradas aguardando cliente',page:'retiradas',tone:'blue'},
        {key:'deliveries',icon:'truck',label:'Entregas para organizar',page:'logistica',tone:'blue'},
        {key:'low_stock',icon:'package-open',label:'Medidas abaixo do estoque mínimo',page:'estoque',tone:'orange'},
      ].map(row=>({...row,value:a?.[row.key]??null}));
    },
    overviewGo(page,tab) {
      if (!this.panelPageEnabled(page)) return;
      if (page==='compras'&&tab) this.comprasTab=tab;
      if (page==='bot') { this.botTab='conversas'; this.botConversaFiltro='humano'; this.botFilaPagina=1; }
      if (page==='estoque') this.stockTab='reposicao';
      if (page==='clientes') this.clientesTab='kanban';
      this.currentPage=page;
    },
    overviewLeadUrl(lead) {
      return this.clienteLeadConversaUrl({chatwoot_account_id:this.chatwootAccountId,chatwoot_conversation_id:lead.chatwoot_conversation_id});
    },
    overviewInitials(name) { return String(name || 'Cliente').trim().split(/\s+/).slice(0,2).map(v=>v[0]).join('').toUpperCase(); },
    overviewWait(hours) { return Number(hours)<24 ? `${Math.max(1,Math.floor(Number(hours)))} h` : `${Math.floor(Number(hours)/24)} d`; },
    overviewUpdated() {
      return this.overview?.updated_at ? new Date(this.overview.updated_at).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit',timeZone:'America/Sao_Paulo'}) : '—';
    },
  };
};
