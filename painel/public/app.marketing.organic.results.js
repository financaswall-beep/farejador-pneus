// Vendas vinculadas e métricas do post. Não infere origem por nome, telefone ou data.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.marketingOrganicResults = function () {
  const number = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
  const count = v => number(v) != null && Number.isInteger(v) ? v : null;
  const normalize = v => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('pt-BR');
  let journeyFocus = null;
  return {
    moSalesSearch:'', moSalesStatus:'completed', moSalesPage:1, moJourneySale:null, moShowFailures:false,
    moInsights:null, moInsightsLoading:false, moInsightsError:'', moInsightsKey:'', moInsightsSeq:0,
    async moLoadInsights(force=false) {
      const post=this.moSelected;
      if(!post || this.marketingIsMock()) {
        if(this.moInsightsKey){this.moInsightsSeq++;this.moInsightsKey='';this.moInsights=null;this.moInsightsLoading=false;this.moInsightsError='';}
        return;
      }
      const key=post.platform+':'+post.id;
      if(!force && this.moInsightsKey===key)return;
      const seq=++this.moInsightsSeq;
      this.moInsightsKey=key;this.moInsights=null;this.moInsightsLoading=true;this.moInsightsError='';
      try{const data=await this.apiGet('/admin/api/marketing/organic/publications/'+post.platform+'/'+encodeURIComponent(post.id)+'/insights');
        if(this.moInsightsKey===key && this.moInsightsSeq===seq && !this.marketingIsMock())this.moInsights=data;}
      catch{if(this.moInsightsKey===key && this.moInsightsSeq===seq)this.moInsightsError='Não foi possível consultar as métricas da Meta.';}
      finally{if(this.moInsightsSeq===seq)this.moInsightsLoading=false;}
    },
    moResetResults() {
      this.moSalesSearch='';this.moSalesStatus='completed';this.moSalesPage=1;this.moShowFailures=false;
      this.moJourneySale=null;this.$refs.moJourneyDialog?.close();journeyFocus=null;
    },
    moAnalysisSubtitle() {
      return ({summary:'Acompanhe as conversas e as vendas que começaram neste post.',compare:'Compare os posts e acompanhe as vendas que vieram deles.',
        sales:'Consulte as vendas e confira a origem de cada atendimento.',metrics:'Entenda as respostas, a conversão e o tempo até confirmar o pedido.'})[this.moAnalysisTab];
    },
    moMoveAnalysisTab(event, direction) {
      const tabs=['summary','compare','sales','metrics'], index=tabs.indexOf(this.moAnalysisTab);
      const next=direction==='first'?0:direction==='last'?3:(index+direction+4)%4;
      void this.moSwitchAnalysis(tabs[next]);
      this.$nextTick(()=>this.$refs.moTabs?.querySelector('[aria-selected="true"]')?.focus());
    },
    moResultValue(field) { return this.moSummaryReady() && !this.moDetailLoading && !this.moDetailError ? number(this.moDetail?.attribution?.[field]) : null; },
    moResultCount(field) { return count(this.moResultValue(field)); },
    moAverageSale() { const sales=this.moResultCount('sales'), revenue=this.moResultValue('revenue');return sales>0 && revenue!=null ? revenue/sales : null; },
    moSafeSocialUrl(url) {
      try {const u=new URL(url);return u.protocol==='https:' && /(^|\.)(facebook\.com|instagram\.com)$/.test(u.hostname) ? u.href : null;} catch {return null;}
    },
    moSalesReady() { return this.moSummaryReady() && !this.moDetailLoading && !this.moDetailError && this.moDetail.attribution.sales_rows_complete===true && Array.isArray(this.moDetail.attribution.sales_rows); },
    moConfirmedSales() {
      if(!this.moSalesReady())return [];
      const data=this.moDetail.attribution, grouped=new Map(), date=v=>Number.isFinite(Date.parse(v)) ? new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo'}).format(new Date(v)) : '';
      for(const row of data.sales_rows) {
        if(!row || typeof row.order_id!=='string' || !row.order_id || row.source_confirmed!==true || !['completed','cancelled'].includes(row.status))continue;
        if(number(row.amount)==null)continue;
        const previous=grouped.get(row.order_id);
        // A versão cancelada prevalece; cópias iguais não multiplicam a venda.
        if(!previous || row.status==='cancelled')grouped.set(row.order_id,row);
      }
      return [...grouped.values()].filter(row=>{const day=date(row.completed_at || row.cancelled_at);return day && day>=data.period.since && day<=data.period.until;})
        .sort((a,b)=>Date.parse(a.completed_at || a.cancelled_at)-Date.parse(b.completed_at || b.cancelled_at));
    },
    moSalesFiltered() {
      const term=normalize(this.moSalesSearch.trim());
      return this.moConfirmedSales().filter(row=>(this.moSalesStatus==='all' || row.status===this.moSalesStatus)
        && (!term || normalize(row.customer_name+' '+row.order_number+' '+row.order_id).includes(term)));
    },
    moSalesFilterChanged() { this.moSalesPage=1;this.$nextTick(()=>lucide.createIcons()); },
    moSalesPages() { return Math.max(1,Math.ceil(this.moSalesFiltered().length/8)); },
    moSalesRows() { return this.moSalesFiltered().slice((this.moSalesPage-1)*8,this.moSalesPage*8); },
    moSalesPageChange(delta) { this.moSalesPage=Math.max(1,Math.min(this.moSalesPages(),this.moSalesPage+delta));this.$nextTick(()=>lucide.createIcons()); },
    moSalesTotal() { const rows=this.moSalesFiltered().filter(r=>r.status==='completed');return {count:rows.length,amount:Math.round(rows.reduce((s,r)=>s+r.amount,0)*100)/100}; },
    moSaleDate(row) { const value=row.completed_at || row.cancelled_at;return new Date(value).toLocaleDateString('pt-BR',{day:'2-digit',month:'short',timeZone:'America/Sao_Paulo'}); },
    moInitials(name) { const parts=String(name || 'Cliente').trim().split(/\s+/);return (parts[0][0]+(parts.length>1?parts.at(-1)[0]:'')).toUpperCase(); },
    moOpenSaleJourney(row) {
      if(!this.moConfirmedSales().some(s=>s.order_id===row.order_id))return;
      journeyFocus=document.activeElement;this.moJourneySale=row;this.$refs.moJourneyDialog.showModal();this.$nextTick(()=>lucide.createIcons());
    },
    moCloseSaleJourney() { this.moJourneySale=null;this.$refs.moJourneyDialog?.close();journeyFocus?.focus();journeyFocus=null; },
    moSaleJourneySteps() {
      const sale=this.moJourneySale;if(!sale)return [];
      const origin=sale.origin || {};
      return [
        {icon:'message-square',label:'Comentário de origem',time:origin.commented_at,text:origin.comment_text || 'Texto do comentário não disponível.',url:this.moSafeSocialUrl(origin.comment_url)},
        {icon:'send',label:'Mensagem privada',time:origin.private_sent_at,text:origin.private_sent_at?'Envio registrado para este comentário.':'Envio privado ainda sem registro.'},
        {icon:'messages-square',label:'Conversa iniciada',time:origin.first_reply_at,text:origin.conversation_id?'Conversa #'+origin.conversation_id:'Conversa ainda sem referência.'},
        {icon:sale.status==='cancelled'?'circle-x':'shopping-cart',label:sale.status==='cancelled'?'Venda cancelada':'Venda concluída',time:sale.status==='cancelled'?sale.cancelled_at:sale.completed_at,text:'Venda #'+sale.order_number+' · '+this.moSummaryNumber(sale.amount,true)},
      ];
    },
    moResponseSplit() {
      const sent=this.moResultCount('private_messages'), replied=this.moResultCount('private_replied');
      return sent!=null && replied!=null && replied<=sent ? {sent,replied,pending:sent-replied,rate:sent>0?replied/sent*100:null} : null;
    },
    moSendingSplit() {
      const sent=this.moResultCount('private_messages'), failed=this.moResultCount('private_failed');
      return sent!=null && failed!=null ? {sent,failed,total:sent+failed,rate:sent+failed>0?sent/(sent+failed)*100:null} : null;
    },
    moConversationSplit() {
      const total=this.moResultCount('conversations'), converted=this.moResultCount('converted_conversations');
      return total!=null && converted!=null && converted<=total ? {total,converted,pending:total-converted,rate:total>0?converted/total*100:null} : null;
    },
    moMetricPercent(value) { return number(value)==null?'—':value.toLocaleString('pt-BR',{minimumFractionDigits:1,maximumFractionDigits:1})+'%'; },
    moTimeBuckets() {
      const values=this.moSummaryReady()?this.moDetail?.attribution?.confirmation_time_buckets:null, sales=this.moResultCount('confirmed_orders');
      if(!Array.isArray(values) || values.length!==4 || values.some(v=>count(v)==null) || sales==null || values.reduce((s,v)=>s+v,0)>sales)return null;
      return values.map((value,i)=>({label:['Até 1 hora','De 1 a 12 horas','De 12 a 24 horas','Mais de 24 horas'][i],value}));
    },
    moTimedSales() { const rows=this.moTimeBuckets();return rows?rows.reduce((s,r)=>s+r.value,0):null; },
    moTimeBarWidth(value) { const rows=this.moTimeBuckets();return rows && Math.max(...rows.map(r=>r.value))>0 ? value/Math.max(...rows.map(r=>r.value))*100 : 0; },
    moMedianTime() {
      const minutes=this.moResultValue('median_confirmation_minutes');if(minutes==null || !this.moTimedSales())return '—';
      const total=Math.round(minutes), hours=Math.floor(total/60), rest=total%60;
      return total===0?'< 1 min':hours?hours+'h'+(rest?' '+rest+'min':''):rest+' min';
    },
    moMetricCards() {
      const response=this.moResponseSplit(), conversion=this.moConversationSplit(), sales=this.moResultCount('sales'), revenue=this.moResultValue('revenue');
      return [
        {icon:'message-square',value:this.moMetricPercent(response?.rate),label:'Responderam no privado',detail:response?response.replied+' de '+response.sent+' mensagens enviadas':'Aguardando registro das respostas'},
        {icon:'shopping-cart',value:this.moMetricPercent(conversion?.rate),label:'Conversas que viraram vendas',detail:conversion?conversion.converted+' de '+conversion.total+' conversas':'Aguardando origem das vendas',green:true},
        {icon:'clock-3',value:this.moMedianTime(),label:'Tempo até confirmar o pedido',detail:'Mediana da primeira resposta ao aceite; não inclui entrega'},
        {icon:'coins',value:this.moSummaryNumber(this.moAverageSale(),true),label:'Valor médio por venda',detail:sales!=null && revenue!=null?this.moSummaryNumber(revenue,true)+' em '+sales+' vendas':'Aguardando vendas confirmadas'},
      ];
    },
    moFailures() { return this.moSummaryReady() && Array.isArray(this.moDetail?.attribution?.private_failures) ? this.moDetail.attribution.private_failures : []; },
    moOpenGeneralJourneys() { this.marketingSetTab('jornadas'); },
    moResultsExportRows() {
      const period=this.moSummaryWindow(), head=[['Dados',this.marketingIsMock()?'Ilustrativos':'Reais'],['Publicação',this.moSelected?.title],['Rede',this.moSelected?.platform],['ID',this.moSelected?.id],['Início',period?.since],['Fim',period?.until],['Origem',this.moSummaryReady()?'Confirmada':'Vínculo pendente']];
      if(this.moAnalysisTab==='sales')return [...head,['Lista de vendas',this.moSalesReady()?'Completa':'Indisponível'],['Filtro',this.moSalesStatus],['Busca',this.moSalesSearch],[],['Data','Cliente','Venda','Valor','Situação'],
        ...this.moSalesFiltered().map(r=>[r.completed_at || r.cancelled_at,r.customer_name,r.order_number,r.amount,r.status==='completed'?'Concluída':'Cancelada']),
        ['Total concluído no filtro',this.moSalesReady()?this.moSalesTotal().count:'Indisponível',this.moSalesReady()?this.moSalesTotal().amount:'Indisponível'],['Observação','Cancelamentos fora dos totais. Valor vendido não representa lucro.']];
      return [...head,...this.moMetricCards().map(c=>[c.label,c.value,c.detail]),[],['Envios com falha',this.moResultCount('private_failed') ?? 'Indisponível'],['Pedidos com tempo registrado',this.moTimedSales() ?? 'Indisponível'],
        ...(this.moTimeBuckets() || []).map(r=>[r.label,r.value]),
        [],['Métricas da Meta','Acumulado da publicação; pode incluir impulsionamento'],['Consultado em',this.moInsights?.fetched_at || 'Não consultado'],
        ...(this.moInsights?.rows || []).map(r=>[r.label,r.value ?? 'Indisponível']),
        ['Observação','Mensagem enviada não significa lida. Sem resposta não significa venda perdida.']];
    },
    moExportResults() { if(!this.moDetail || this.moDetailLoading || this.moDetailError)return;this.moDownloadCsv(this.moResultsExportRows(),'publicacao-'+this.moSelected.id+'-'+this.moAnalysisTab+'-'+this.moSummaryPeriod+'.csv'); },
  };
};
