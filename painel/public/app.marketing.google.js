// Google Ads: relatório da API, sem inferir vendas a partir de conversões da plataforma.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.marketingGoogle = function () {
  return {
    googleAdsReport: null, googleAdsLoading: false, googleAdsError: '', googleAdsSeq: 0,
    googleAdsSearch: '', googleAdsPage: 1,
    googleAdsView: 'campaigns', googleAdsCampaign: '', googleAdsSelected: [], googleAdsDetailId: '',
    googleCompareA: '', googleCompareB: '', googleAdsSyncing: false,
    googleAdsOpen() {
      this.marketingCampaignChannel = 'google';
      this.googleAdsView = 'campaigns';
      this.googleCampaignReturnId = '';
      this.marketingSetTab('visao');
    },
    async loadGoogleAds() {
      const seq = ++this.googleAdsSeq, period = this.marketingPeriod;
      this.googleAdsLoading = true; this.googleAdsError = ''; this.googleAdsReport = null; this.googleAdsPage = 1;
      this.googleAdPage = 1;
      this.googleCampaignInvalidateActivity?.();
      this.googleCampaignOrderPage = 1; this.googleCampaignConversationPage = 1;
      this.googleCampaignAdPage = 1;
      try {
        const report = this.marketingIsMock()
          ? { status: 'disabled', detail: 'Prévia: a conexão real exige autorização da conta Google Ads.', missing: [], data: null }
          : await this.apiGet(`/admin/api/marketing/google-ads?period=${encodeURIComponent(period)}`);
        if (seq === this.googleAdsSeq && period === this.marketingPeriod) {
          this.googleAdsReport = report;
          const ids=new Set((report.data?.ads||[]).map(r=>r.id));
          this.googleAdsSelected=this.googleAdsSelected.filter(id=>ids.has(id));
          if(this.googleAdsView==='detail' && !ids.has(this.googleAdsDetailId))this.googleAdsView='ads';
          if(this.googleAdsView==='compare' && (!ids.has(this.googleCompareA)||!ids.has(this.googleCompareB)))this.googleAdsView='ads';
          if (this.googleAdsView === 'campaign') {
            if (!(report.data?.campaigns || []).some(row => row.id === this.googleCampaignId)) this.googleSetView('campaigns');
            else void this.loadGoogleCampaignActivity();
          }
        }
      } catch {
        if (seq === this.googleAdsSeq) this.googleAdsError = 'Não foi possível consultar o Google Ads. Tente novamente.';
      } finally {
        if (seq === this.googleAdsSeq) {
          this.googleAdsLoading = false;
          this.$nextTick(() => {
            lucide.createIcons();
            this.renderGoogleOverviewChart();
            this.renderGoogleCampaignChart?.();
          });
        }
      }
    },
    googleAdsRows() {
      return this.googleOverviewRows();
    },
    googleAdsPages() { return Math.max(1, Math.ceil(this.googleAdsRows().length / 15)); },
    googleAdsPageRows() { return this.googleAdsRows().slice((this.googleAdsPage - 1) * 15, this.googleAdsPage * 15); },
    googleAdsStatus(status) { return { ENABLED: 'Ativa', PAUSED: 'Pausada', REMOVED: 'Removida' }[status] || 'Não informado'; },
    googleResult(row,level='ad') {
      const results=this.googleAdsReport?.results,available=results?.available===true;
      const found=(level==='ad'?results?.ads:results?.campaigns)?.find(r=>r.id===row?.id);
      const data={attributed_sales:available?found?.attributed_sales||0:null,
        attributed_revenue:available?found?.attributed_revenue||0:null,
        gross_margin:available?(found?found.gross_margin:0):null,
        tracked_conversations:available?found?.tracked_conversations||0:null,
        product_cost:available?(found?found.product_cost??null:0):null,
        partner_payout:available?(found?found.partner_payout??null:0):null,
        pending_margin_orders:available?found?.pending_margin_orders||0:null};
      return {...data,result:data.gross_margin==null?null:data.gross_margin-Number(row?.investment||0),
        roas:Number(row?.investment)>0&&data.attributed_revenue!=null?data.attributed_revenue/row.investment:null};
    },
    googleToggleAd(id) {
      if(this.googleAdsSelected.includes(id))this.googleAdsSelected=this.googleAdsSelected.filter(x=>x!==id);
      else if(this.googleAdsSelected.length<2)this.googleAdsSelected=[...this.googleAdsSelected,id];
      this.$nextTick(() => lucide.createIcons());
    },
    googleOpenAd(id) {this.googleAdsDetailId=id;this.googleAdsView='detail';},
    googleAdById(id) {return (this.googleAdsReport?.data?.ads||[]).find(row=>row.id===id);},
    googleShowCompare() {
      if(this.googleAdsSelected.length!==2)return;
      [this.googleCompareA,this.googleCompareB]=this.googleAdsSelected;this.googleAdsView='compare';
    },
    googleCompareRows() {
      const a=this.googleAdById(this.googleCompareA),b=this.googleAdById(this.googleCompareB);
      if(!a||!b||a.id===b.id)return [];
      const ra=this.googleResult(a),rb=this.googleResult(b);
      return [
        ['Investimento',this.paidMoney(a.investment),this.paidMoney(b.investment)],
        ['Impressões',this.paidNumber(a.impressions),this.paidNumber(b.impressions)],
        ['Cliques',this.paidNumber(a.clicks),this.paidNumber(b.clicks)],
        ['CTR',a.ctr==null?'—':this.paidNumber(a.ctr)+'%',b.ctr==null?'—':this.paidNumber(b.ctr)+'%'],
        ['Custo por clique',this.paidMoney(a.cpc),this.paidMoney(b.cpc)],
        ['CPM',this.paidMoney(a.cpm),this.paidMoney(b.cpm)],
        ['Conversões no Google',this.paidNumber(a.conversions),this.paidNumber(b.conversions)],
        ['Conversas identificadas',this.paidNumber(ra.tracked_conversations),this.paidNumber(rb.tracked_conversations)],
        ['Vendas atribuídas',this.paidNumber(ra.attributed_sales),this.paidNumber(rb.attributed_sales)],
        ['Receita atribuída',this.paidMoney(ra.attributed_revenue),this.paidMoney(rb.attributed_revenue)],
        ['Margem antes da mídia',this.paidMoney(ra.gross_margin),this.paidMoney(rb.gross_margin)],
        ['ROAS',this.paidNumber(ra.roas),this.paidNumber(rb.roas)],
        ['Resultado após mídia',this.paidMoney(ra.result),this.paidMoney(rb.result)],
      ].map(([label,a,b])=>({label,a,b}));
    },
    googleAdChart(ids) {
      const ads=ids.map(id=>this.googleAdById(id)).filter(Boolean),window=this.googleAdsReport?.data?.period;
      if(!window)return {lines:[],max:0};
      const start=Date.parse(window.since),end=Date.parse(window.until),duration=Math.max(86400000,end-start);
      const max=Math.max(1,...ads.flatMap(ad=>ad.daily.filter(day=>day.clicks>0).map(day=>Number(day.cost_micros)/1e6/day.clicks)));
      return {max,lines:ads.map((ad,index)=>({id:ad.id,name:ad.name,color:index?'#647c9c':'#006653',
        points:ad.daily.filter(day=>day.clicks>0).map(day=>`${40+(Date.parse(day.date)-start)/duration*840},${200-(Number(day.cost_micros)/1e6/day.clicks)/max*165}`).join(' ')}))};
    },
    googleAdOrders(id) {return (this.googleAdsReport?.results?.orders||[]).filter(row=>row.ad_id===id);},
    googleConversionStatus(status) {
      return {pending:'Na fila',processing:'Enviando',accepted:'Processando no Google',sent:'Processamento confirmado',
        failed:'Falha temporária',suppressed:'Não elegível',dead_letter:'Falha no envio',review:'Conferir envio'}[status]||'Ainda não enfileirada';
    },
    async googleSync() {
      if(this.googleAdsSyncing||this.marketingIsMock())return;
      this.googleAdsSyncing=true;this.googleAdsError='';
      try {await this.apiPost('/admin/api/marketing/google-ads/sync',{});await this.loadGoogleAds();}
      catch {this.googleAdsError='A coleta não foi concluída. Os dados e lançamentos anteriores foram preservados.';}
      finally {this.googleAdsSyncing=false;}
    },
    googleAdsExport() {
      if(this.googleAdsView==='ads') {this.googleAdExport();return;}
      if(this.googleAdsView==='compare') {
        this.googleExportCells([['Indicador','Anúncio A','Anúncio B'],...this.googleCompareRows().map(row=>[row.label,row.a,row.b])]);return;
      }
      const rows = this.googleAdsRows();
      if (!rows.length) return;
      const cells = [['ID', 'Campanha', 'Status', 'Tipo', 'Investimento BRL', 'Impressões', 'Cliques', 'CTR %', 'CPC BRL',
        'Conversões Google', 'Conversas identificadas', 'Vendas atribuídas', 'Receita BRL', 'Resultado após mídia BRL'],
        ...rows.map(row => [row.id, row.name, this.googleAdsStatus(row.status), this.googleCampaignType(row.channel_type),
          row.investment, row.impressions, row.clicks, row.ctr, row.cpc, row.conversions,
          row.tracked_conversations, row.attributed_sales, row.attributed_revenue, row.result])];
      this.googleExportCells(cells);
    },
    googleExportCells(cells) {
      const escape = value => `"${String(value ?? '').replace(/^[=+@\-\t\r]/, "' $&").replaceAll('"', '""')}"`;
      const url = URL.createObjectURL(new Blob(['\uFEFF' + cells.map(row => row.map(escape).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url; link.download = `google-ads-${this.marketingPeriod}.csv`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  };
};
