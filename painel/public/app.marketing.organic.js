// Conteúdo orgânico: lista simples e resumo somente com dados confirmados.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.marketingOrganic = function () {
  return {
    moView: 'publisher', moPeriod: '30d', moNetwork: 'all', moSearch: '', moSort: 'recent', moPage: 1,
    moData: null, moLoading: false, moError: '', moSeq: 0,
    moSelected: null, moDetail: null, moDetailLoading: false, moDetailError: '', moDetailSeq: 0,
    moControls:null, moControlBusy:false, moControlError:'', moInboxSelection:{},
    async moLoadControls() {
      this.moControlError='';
      if(this.marketingIsMock()){this.moControls=null;return;}
      try {const data=await this.apiGet('/admin/api/marketing/organic/controls');
        this.moControls=this.marketingIsMock()?null:data;}
      catch {this.moControlError='Não foi possível consultar a automação privada.';}
    },
    async moControlAction(channel,action) {
      if(this.moControlBusy || this.marketingIsMock())return;
      this.moControlBusy=true;this.moControlError='';
      try {
        await this.apiPost('/admin/api/marketing/organic/controls',{platform:channel.platform,action,
          ...(action==='verify'?{inbox_id:Number(this.moInboxSelection[channel.platform])}: {})});
        await this.moLoadControls();
      }catch(error){this.moControlError=({organic_inbound_test_required:'Envie uma mensagem de teste para esta conta e confira a chegada no Chatwoot antes de verificar.',
        organic_inbox_mismatch:'A caixa escolhida não corresponde ao canal ou precisa ser reconectada.',
        organic_messaging_permissions_missing:'O token ainda precisa das permissões de mensagens privadas.',
        organic_runtime_not_ready:'A configuração de áudio, atendimento ou mensagens privadas ainda está pendente no servidor.'})[error?.message] || 'Não foi possível concluir. Confira a conexão e tente novamente.';}
      finally{this.moControlBusy=false;}
    },
    async moFinishInterest(id,status) {
      if(this.moControlBusy || this.marketingIsMock())return;
      this.moControlBusy=true;this.moControlError='';
      try{await this.apiPost('/admin/api/marketing/organic/interests/'+id,{status});await this.moLoadControls();}
      catch{this.moControlError='Não foi possível atualizar o interesse.';}
      finally{this.moControlBusy=false;}
    },
    async loadMarketingOrganic() {
      if (this.moView === 'publisher') return this.mpLoad();
      if (this.moView === 'attendance') {void this.moLoadControls();return this.loadMarketingComments();}
      return this.moLoad();
    },
    moTabs() {
      return [
        { id: 'create', label: 'Criar publicação' },
        { id: 'calendar', label: 'Calendário' },
        { id: 'drafts', label: 'Rascunhos' },
        { id: 'results', label: 'Resultados' },
        { id: 'attendance', label: 'Atendimento' },
      ];
    },
    moActiveTab() {
      if (this.moView === 'publisher') return this.mpTab;
      return this.moView === 'publications' ? 'results' : 'attendance';
    },
    moSetTab(tab) {
      if (tab === 'published') tab = 'results';
      if (!this.moTabs().some(item => item.id === tab)) return;
      if (tab === 'results') return this.moSetView('publications');
      if (tab === 'attendance') return this.moSetView('attendance');
      this.mpTab = tab;
      if (this.moView !== 'publisher') this.moSetView('publisher');
      else {
        if (!this.mpConfig) void this.mpLoad();
        this.$nextTick(() => lucide.createIcons());
      }
    },
    moSetView(view) {
      this.morStopRefresh?.();
      this.moClose();
      if (this.moView === 'publisher' && view !== 'publisher') this.mpClose();
      this.moView = view;
      if (view === 'publisher') void this.mpLoad();
      else if (view === 'attendance') {void this.loadMarketingComments();void this.moLoadControls();}
      else if (!this.moData) void this.moLoad();
      this.$nextTick(() => lucide.createIcons());
    },
    async moLoad() {
      const seq = ++this.moSeq;
      this.moLoading = true; this.moError = ''; this.moData = null; this.moPage = 1;
      try {
        const data = this.marketingIsMock() ? marketingOrganicMock()
          : await this.apiGet('/admin/api/marketing/organic/results?period=' + this.moPeriod);
        if (seq !== this.moSeq) return;
        this.moData = data;
        this.morScheduleRefresh?.();
      } catch { if (seq === this.moSeq) this.moError = 'Não foi possível consultar as publicações. Tente novamente.'; }
      finally {
        if (seq === this.moSeq) { this.moLoading = false; this.$nextTick(() => lucide.createIcons()); }
      }
    },
    moFiltered() {
      const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
      const term = normalize(this.moSearch.trim());
      return (this.moData?.rows || []).filter(row => (this.moNetwork === 'all' ||
        (row.deliveries ? row.deliveries.some(d => d.platform === this.moNetwork) : row.platform === this.moNetwork))
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
    moListAvailable() { return this.moData?.central_available === true || this.moSources().some(source => source.status === 'ready'); },
    moNetworkLabel(platform) { return ({instagram:'Instagram',facebook:'Facebook',tiktok:'TikTok',youtube:'YouTube'})[platform] || 'Todas as redes'; },
    moFormat(format) { return ({image:'Imagem',video:'Vídeo',reel:'Reel',carousel:'Carrossel',text:'Texto'})[format] || 'Não informado'; },
    moDate(value, time = false) {
      if (!value || !Number.isFinite(Date.parse(value))) return '—';
      return new Date(value).toLocaleString('pt-BR', {timeZone:'America/Sao_Paulo', day:'2-digit', month:'short',
        ...(time ? {hour:'2-digit',minute:'2-digit'} : {year:'numeric'})});
    },
    moImageFailed(row) { row.image_url = null; this.$nextTick(() => lucide.createIcons()); },
    async moOpen(row, keepPeriod = false) {
      const wasOpen = this.$refs.moDialog?.open;
      if (!wasOpen) this._moReturnFocus = document.activeElement;
      if (!keepPeriod) { this.moSummaryPeriod = '7d'; this.moResetCompare?.(); this.moResetResults?.(); this.morNetwork = 'all'; }
      this.moDestroyChart();
      this.morDestroyViewsChart?.();
      this.moSelected = row; this.moDetail = null; this.moDetailError = ''; this.moDetailLoading = true;
      const seq = ++this.moDetailSeq;
      this.$nextTick(() => {
        if (!this.moSelected) return;
        if (!this.$refs.moDialog.open) this.$refs.moDialog.showModal();
        if (!wasOpen) this.$refs.moClose?.focus(); lucide.createIcons();
      });
      try {
        const detail = this.marketingIsMock() ? marketingOrganicMockDetail(row, this.moSummaryPeriod)
          : await this.apiGet(this.moDetailUrl(row, this.moSummaryPeriod));
        if (seq !== this.moDetailSeq) return;
        this.moDetail = detail; this.moSelected = detail.publication;
      } catch { if (seq === this.moDetailSeq) this.moDetailError = 'Não foi possível abrir o resumo. O post pode ter sido removido ou estar temporariamente indisponível.'; }
      finally { if (seq === this.moDetailSeq) { this.moDetailLoading = false; this.$nextTick(() => { lucide.createIcons(); this.moRenderChart(); this.morRenderViewsChart?.(); }); } }
    },
    moDetailUrl(row, period) {
      return row.key ? '/admin/api/marketing/organic/results/' + encodeURIComponent(row.key) + '?window=' + period + '&network=' + (this.morNetwork || 'all')
        : '/admin/api/marketing/organic/publications/' + row.platform + '/' + encodeURIComponent(row.id) + '?window=' + period;
    },
    moClose() {
      ++this.moDetailSeq; this.moDetailLoading = false; this.moSelected = null; this.moDetail = null;
      this.moDestroyChart();
      this.morClose?.();
      this.moResetCompare?.();
      this.moResetResults?.();
      this.$refs.moDialog?.close(); this._moReturnFocus?.focus(); this._moReturnFocus = null;
    },
    moGoAttendance() { this.moSetView('attendance'); },
  };
};
