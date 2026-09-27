// Conteúdo orgânico: lista simples e resumo somente com dados confirmados.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.marketingOrganic = function () {
  return {
    moView: 'publications', moPeriod: '30d', moNetwork: 'all', moSearch: '', moSort: 'recent', moPage: 1,
    moData: null, moLoading: false, moError: '', moSeq: 0,
    moSelected: null, moDetail: null, moDetailLoading: false, moDetailError: '', moDetailSeq: 0,
    async loadMarketingOrganic() {
      if (this.moView === 'attendance') return this.loadMarketingComments();
      return this.moLoad();
    },
    moSetView(view) {
      this.moView = view;
      if (view === 'attendance') void this.loadMarketingComments();
      else if (!this.moData) void this.moLoad();
      this.$nextTick(() => lucide.createIcons());
    },
    async moLoad() {
      const seq = ++this.moSeq;
      this.moLoading = true; this.moError = ''; this.moData = null; this.moPage = 1;
      try {
        const data = this.marketingIsMock() ? marketingOrganicMock()
          : await this.apiGet('/admin/api/marketing/organic/publications?period=' + this.moPeriod);
        if (seq !== this.moSeq) return;
        this.moData = data;
      } catch { if (seq === this.moSeq) this.moError = 'Não foi possível consultar as publicações. Tente novamente.'; }
      finally {
        if (seq === this.moSeq) { this.moLoading = false; this.$nextTick(() => lucide.createIcons()); }
      }
    },
    moFiltered() {
      const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
      const term = normalize(this.moSearch.trim());
      return (this.moData?.rows || []).filter(row => (this.moNetwork === 'all' || row.platform === this.moNetwork)
        && (!term || normalize(row.title + ' ' + row.caption).includes(term)))
        .sort((a, b) => (this.moSort === 'oldest' ? 1 : -1) * (Date.parse(a.published_at) - Date.parse(b.published_at))
          || (a.platform + a.id).localeCompare(b.platform + b.id));
    },
    moPageCount() { return Math.max(1, Math.ceil(this.moFiltered().length / 8)); },
    moRows() { return this.moFiltered().slice((this.moPage - 1) * 8, this.moPage * 8); },
    moFiltersChanged() { this.moPage = 1; this.$nextTick(() => lucide.createIcons()); },
    moChangePage(delta) {
      this.moPage = Math.min(this.moPageCount(), Math.max(1, this.moPage + delta));
      this.$nextTick(() => lucide.createIcons());
    },
    moSources() { return (this.moData?.sources || []).filter(source => this.moNetwork === 'all' || source.platform === this.moNetwork); },
    moWarnings() {
      return this.moSources().filter(source => source.status !== 'ready' || source.truncated).map(source => {
        const name = this.moNetworkLabel(source.platform);
        if (source.truncated) return name + ': a lista está limitada às publicações recentes. Reduza o período para localizar posts mais antigos.';
        if (source.status === 'not_configured') return name + ': a conexão ainda precisa ser configurada.';
        if (/code_(10|190|200)$/.test(source.error || '')) return name + ': confira o acesso e as permissões da conexão em Atendimento.';
        return name + ': não foi possível consultar os posts. Tente atualizar; as outras redes continuam disponíveis.';
      });
    },
    moListAvailable() { return this.moSources().some(source => source.status === 'ready'); },
    moNetworkLabel(platform) { return platform === 'instagram' ? 'Instagram' : 'Facebook'; },
    moFormat(format) { return ({image:'Imagem',video:'Vídeo',reel:'Reel',carousel:'Carrossel',text:'Texto'})[format] || 'Não informado'; },
    moDate(value, time = false) {
      if (!value || !Number.isFinite(Date.parse(value))) return '—';
      return new Date(value).toLocaleString('pt-BR', {timeZone:'America/Sao_Paulo', day:'2-digit', month:'short',
        ...(time ? {hour:'2-digit',minute:'2-digit'} : {year:'numeric'})});
    },
    moImageFailed(row) { row.image_url = null; this.$nextTick(() => lucide.createIcons()); },
    async moOpen(row) {
      const wasOpen = this.$refs.moDialog?.open;
      if (!wasOpen) this._moReturnFocus = document.activeElement;
      this.moSelected = row; this.moDetail = null; this.moDetailError = ''; this.moDetailLoading = true;
      const seq = ++this.moDetailSeq;
      this.$nextTick(() => {
        if (!this.moSelected) return;
        if (!this.$refs.moDialog.open) this.$refs.moDialog.showModal();
        this.$refs.moClose?.focus(); lucide.createIcons();
      });
      try {
        const detail = this.marketingIsMock() ? marketingOrganicMockDetail(row)
          : await this.apiGet('/admin/api/marketing/organic/publications/' + row.platform + '/' + encodeURIComponent(row.id));
        if (seq !== this.moDetailSeq) return;
        this.moDetail = detail; this.moSelected = detail.publication;
      } catch { if (seq === this.moDetailSeq) this.moDetailError = 'Não foi possível abrir o resumo. O post pode ter sido removido ou estar temporariamente indisponível.'; }
      finally { if (seq === this.moDetailSeq) { this.moDetailLoading = false; this.$nextTick(() => lucide.createIcons()); } }
    },
    moClose() {
      ++this.moDetailSeq; this.moDetailLoading = false; this.moSelected = null; this.moDetail = null;
      this.$refs.moDialog?.close(); this._moReturnFocus?.focus(); this._moReturnFocus = null;
    },
    moCommentCards() {
      const comments = this.moDetail?.summary?.available ? this.moDetail.summary.comments : null;
      return [
        {label:'Comentários recebidos',value:comments?.received ?? null,icon:'messages-square',note:'Capturados pelo Farejador'},
        {label:'Comentários respondidos',value:comments?.replied ?? null,icon:'message-circle-check',note:'Resposta confirmada na rede'},
        {label:'Em atendimento',value:comments?.pending ?? null,icon:'clock-3',note:'Aguardando análise ou envio'},
        {label:'Precisam de atenção',value:comments?.failed ?? null,icon:'circle-alert',note:'Falha ou envio sem confirmação'},
      ];
    },
    moSeries() {
      const rows = this.moDetail?.summary?.series || [];
      const max = Math.max(1, ...rows.map(row => row.received));
      return rows.map(row => ({...row, height:Math.max(4, row.received / max * 100),
        label:this.moDate(row.date + 'T12:00:00-03:00').replace(/ de \d{4}$/, '')}));
    },
    moGoAttendance() { this.moClose(); this.moSetView('attendance'); },
  };
};
