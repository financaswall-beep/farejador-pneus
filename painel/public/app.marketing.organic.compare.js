// Comparação de publicações. Usa o detalhe autorizado de cada post, sem somar dados ausentes.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.marketingOrganicCompare = function () {
  const key = post => post ? post.platform + ':' + post.id : '';
  const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('pt-BR');
  let pickerFocus = null;
  return {
    moAnalysisTab:'summary', moComparePosts:[null,null], moCompareDetails:[null,null],
    moCompareLoading:false, moCompareErrors:['',''], moCompareSeq:0, moPickerSide:null, moPickerSearch:'',
    moResetCompare() {
      ++this.moCompareSeq; this.moDestroyCompareCharts?.();
      this.moAnalysisTab='summary'; this.moComparePosts=[null,null]; this.moCompareDetails=[null,null];
      this.moCompareLoading=false; this.moCompareErrors=['','']; this.moPickerSide=null;
      this.$refs.moPickerDialog?.close(); pickerFocus=null;
    },
    async moSwitchAnalysis(tab) {
      if (!this.moSelected || !['summary','compare'].includes(tab)) return;
      if (tab===this.moAnalysisTab) return;
      this.moDestroyChart(); this.moDestroyCompareCharts(); this.moAnalysisTab=tab;
      if (tab==='summary') { ++this.moCompareSeq; this.moCompareLoading=false; return this.moOpen(this.moComparePosts[0] || this.moSelected,true); }
      if (!this.moComparePosts[0]) {
        const choices=(this.moData?.rows || []).filter(row=>key(row)!==key(this.moSelected));
        const similar=choices.find(row=>row.platform===this.moSelected.platform && row.format===this.moSelected.format);
        this.moComparePosts=[this.moSelected,similar || choices[0] || null];
      }
      return this.moLoadCompare();
    },
    async moLoadCompare() {
      const seq=++this.moCompareSeq, period=this.moSummaryPeriod, posts=[...this.moComparePosts];
      this.moDestroyCompareCharts(); this.moCompareLoading=true; this.moCompareErrors=['','']; this.moCompareDetails=[null,null];
      const result=await Promise.allSettled(posts.map(post => !post ? Promise.resolve(null) : this.marketingIsMock()
        ? Promise.resolve(marketingOrganicMockDetail(post,period))
        : this.apiGet('/admin/api/marketing/organic/publications/'+post.platform+'/'+encodeURIComponent(post.id)+'?window='+period)));
      if (seq!==this.moCompareSeq || this.moAnalysisTab!=='compare') return;
      this.moCompareDetails=result.map((r,i)=>{
        if (!posts[i]) return null;
        if (r.status==='fulfilled' && key(r.value?.publication)===key(posts[i]) && r.value?.attribution?.period?.id===period) return r.value;
        this.moCompareErrors[i]='Não foi possível consultar o post '+(i===0?'A':'B')+'. Tente novamente.'; return null;
      });
      this.moCompareLoading=false;
      this.$nextTick(()=>{lucide.createIcons();this.moRenderCompareCharts();});
    },
    moCompareLabel(side) { return this.moComparePosts[side]?.title || 'Post '+(side===0?'A':'B'); },
    moCompareContext(post) {
      if (!post) return '';
      const measure=(post.title+' '+post.caption).match(/\b\d{2,3}\/\d{2,3}\s*[-R]\s*\d{2}\b/i)?.[0];
      return (measure ? measure+' · ' : '')+'Publicado em '+this.moDate(post.published_at).replace(/ de /g,' ');
    },
    moCompareReady(side) {
      const d=this.moCompareDetails[side];
      return !this.moCompareLoading && d?.attribution?.status==='ready' && d.attribution.period?.id===this.moSummaryPeriod
        && key(d.publication)===key(this.moComparePosts[side]);
    },
    moCompareValue(side, field) { return this.moCompareReady(side) ? number(this.moCompareDetails[side].attribution[field]) : null; },
    moCompareConversion(side) {
      const total=this.moCompareValue(side,'conversations'), converted=this.moCompareValue(side,'converted_conversations');
      return total>0 && converted!=null && converted<=total ? converted/total*100 : null;
    },
    moCompareComplete(side) {
      const until=this.moCompareDetails[side]?.attribution?.period?.until;
      const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo'}).format(new Date());
      return this.moCompareReady(side) && /^\d{4}-\d{2}-\d{2}$/.test(until || '') && until<today;
    },
    moCompareFair() { return this.moCompareComplete(0) && this.moCompareComplete(1); },
    moCompareNotice() {
      if (!this.moComparePosts[1]) return 'Escolha outra publicação para comparar. Se precisar, amplie o período na lista de posts.';
      if (this.moCompareLoading || this.moCompareErrors.some(Boolean)) return '';
      if (![0,1].every(i=>this.moCompareReady(i))) return 'O vínculo entre post, conversa e venda ainda está pendente. Dados ausentes aparecem como —.';
      if (!this.moCompareFair()) return 'Período ainda em andamento para pelo menos um post. Os dados são parciais; a comparação final estará disponível quando os dois completarem a janela.';
      return '';
    },
    moCompareRows() {
      return [
        {key:'private_messages',label:'Mensagens privadas enviadas'}, {key:'conversations',label:'Conversas iniciadas'},
        {key:'sales',label:'Vendas concluídas'}, {key:'conversion',label:'Conversas que viraram vendas'}, {key:'revenue',label:'Valor vendido'},
      ].map(row=>({...row,values:[0,1].map(i=>row.key==='conversion'?this.moCompareConversion(i):this.moCompareValue(i,row.key))}));
    },
    moCompareFormat(value, field) {
      if (value==null) return '—';
      return field==='conversion' ? value.toLocaleString('pt-BR',{minimumFractionDigits:1,maximumFractionDigits:1})+'%' : this.moSummaryNumber(value,field==='revenue');
    },
    moCompareWinner(row, side) {
      return this.moCompareFair() && ['sales','revenue'].includes(row.key) && row.values.every(v=>v!=null) && row.values[side]>row.values[1-side];
    },
    moCompareSeries(side) {
      const data=this.moCompareDetails[side]?.attribution;
      if (!this.moCompareReady(side) || !Array.isArray(data.conversation_series)) return [];
      const rows=[...data.conversation_series].sort((a,b)=>String(a?.date).localeCompare(String(b?.date)));
      const max=this.moSummaryPeriod==='30d'?30:7, start=Date.parse(data.period.since+'T12:00:00Z');
      if (!Number.isFinite(start) || rows.length>max) return [];
      return rows.every((row,i)=>row && row.date===new Date(start+i*86400000).toISOString().slice(0,10)
        && number(row.conversations)!=null && Number.isInteger(row.conversations)
        && (!i || row.conversations>=rows[i-1].conversations)) ? rows.map(row=>row.conversations) : [];
    },
    moCompareTimeline() {
      const a=this.moCompareSeries(0), b=this.moCompareSeries(1), size=Math.min(a.length,b.length);
      return size ? {labels:Array.from({length:size},(_,i)=>'Dia '+(i+1)),a:a.slice(0,size),b:b.slice(0,size)} : null;
    },
    moCompareFunnel() {
      const rows=this.moCompareRows().filter(row=>['private_messages','conversations','sales'].includes(row.key));
      return rows.every(row=>row.values.every(v=>v!=null)) ? rows : null;
    },
    moCompareInsights() {
      if (!this.moCompareFair()) return [];
      return ['sales','revenue'].map(field=>{
        const a=this.moCompareValue(0,field), b=this.moCompareValue(1,field);
        if(a==null || b==null) return null;
        if(a===b) return {side:0,icon:field==='sales'?'chart-no-axes-combined':'coins',title:field==='sales'?'Mesmo número de vendas':'Mesmo valor vendido',text:this.moCompareFormat(a,field)+' em cada publicação.'};
        const side=a>b?0:1, diff=Math.abs(a-b);
        return {side,icon:field==='sales'?'chart-no-axes-combined':'coins',
          title:(field==='sales'?'Mais vendas: ':'Maior valor vendido: ')+this.moCompareLabel(side),
          text:field==='sales'?this.moSummaryNumber(Math.max(a,b))+' contra '+this.moSummaryNumber(Math.min(a,b))+': '+this.moSummaryNumber(diff)+' vendas a mais.':this.moSummaryNumber(diff,true)+' a mais em vendas concluídas.'};
      }).filter(Boolean);
    },
    moOpenPostPicker(side) {
      this.moPickerSide=side; this.moPickerSearch=''; pickerFocus=document.activeElement;
      this.$refs.moPickerDialog.showModal(); this.$nextTick(()=>{this.$refs.moPickerSearch.focus();lucide.createIcons();});
    },
    moClosePostPicker() { this.moPickerSide=null; this.$refs.moPickerDialog?.close(); pickerFocus?.focus(); pickerFocus=null; },
    moPostChoices() {
      const other=key(this.moComparePosts[1-this.moPickerSide]), term=normalize(this.moPickerSearch.trim());
      return (this.moData?.rows || []).filter(post=>key(post)!==other && (!term || normalize(post.title+' '+post.caption).includes(term)));
    },
    async moChooseComparePost(post) {
      const side=this.moPickerSide;
      if (![0,1].includes(side) || !this.moPostChoices().some(row=>key(row)===key(post))) return;
      this.moComparePosts=this.moComparePosts.map((row,i)=>i===side?post:row); this.moClosePostPicker(); return this.moLoadCompare();
    },
    moSwapCompare() {
      if (!this.moComparePosts.every(Boolean) || this.moCompareLoading) return;
      this.moComparePosts=[...this.moComparePosts].reverse(); this.moCompareDetails=[...this.moCompareDetails].reverse(); this.moCompareErrors=[...this.moCompareErrors].reverse();
      this.$nextTick(()=>{lucide.createIcons();this.moRenderCompareCharts();});
    },
    moCompareExportRows() {
      return [['Comparação de publicações',this.marketingIsMock()?'Dados ilustrativos':'Dados reais'],['Indicador','Post A','Post B'],
        ['Publicação',...this.moComparePosts.map(p=>p?.title || 'Não selecionada')],['Rede',...this.moComparePosts.map(p=>p?this.moNetworkLabel(p.platform):'—')],
        ['ID',...this.moComparePosts.map(p=>p?.id || '—')],['Janela',this.moSummaryPeriod],
        ['Início',...this.moCompareDetails.map(d=>d?.attribution?.period?.since || '—')],['Fim',...this.moCompareDetails.map(d=>d?.attribution?.period?.until || '—')],
        ['Situação',...[0,1].map(i=>!this.moCompareReady(i)?'Vínculo pendente':this.moCompareComplete(i)?'Janela completa':'Período em andamento')],
        ...this.moCompareRows().map(row=>[row.label,...row.values.map(v=>v==null?'Indisponível':this.moCompareFormat(v,row.key))]),
        ['Observação','Somente vendas concluídas com origem confirmada. Valores não representam lucro.'],
        [],['Dia desde a publicação','Conversas acumuladas A','Conversas acumuladas B'],
        ...(this.moCompareTimeline()?.labels || []).map((day,i)=>[day,this.moCompareTimeline().a[i],this.moCompareTimeline().b[i]])];
    },
    moExportAnalysis() {
      if (this.moAnalysisTab!=='compare') return this.moExportSummary();
      if (this.moCompareLoading || !this.moCompareDetails.every(Boolean)) return;
      this.moDownloadCsv(this.moCompareExportRows(),'comparacao-publicacoes-'+this.moSummaryPeriod+'.csv');
    },
  };
};
