window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.marketingOrganicNetworks = function () {
  let viewsChart = null;
  const names = {instagram:'Instagram',facebook:'Facebook',tiktok:'TikTok',youtube:'YouTube'};
  const colors = {instagram:'#b13df0',facebook:'#1877f2',tiktok:'#009d91',youtube:'#e53935'};
  const identity = row => row.platform + ':' + row.account_id + ':' + row.post_id;
  return {
    morNetwork:'all', morDays:'7', morMetrics:null, morMetricsKey:'', morMetricsSeq:0,
    morPollTimer:null, morSendingOpen:false,
    morReconciliationMarkup:window.MARKETING_PUBLISHER_RECONCILIATION_TEMPLATE || '',
    morMetricsMarkup:window.MARKETING_ORGANIC_NETWORKS_TEMPLATE || '',
    morContentMarkup:window.MARKETING_ORGANIC_CONTENT_TEMPLATE || '',
    morActivePlatforms() {
      // A lista autorizada vem do servidor; nenhuma plataforma aparece por antecipação.
      const supplied = this.moData?.active_platforms;
      return Array.isArray(supplied) ? supplied.filter(p => Object.hasOwn(names,p))
        : (this.moData?.sources || []).filter(s => s.status === 'ready').map(s => s.platform);
    },
    morDeliveries(post = this.moSelected) {
      const active = this.morActivePlatforms();
      return (post?.deliveries || (post ? [{platform:post.platform,status:'published',post_id:post.id,post_url:post.url}] : []))
        .filter(d => active.includes(d.platform));
    },
    morNetworks() { return [...new Set(this.morDeliveries().map(d => d.platform))]; },
    morNetworkCards() {
      const active = this.morActivePlatforms();
      return (this.morMetrics?.networks || []).filter(n => active.includes(n.platform) &&
        (this.morNetwork === 'all' || n.platform === this.morNetwork));
    },
    morBrand(platform) { return ['instagram','facebook'].includes(platform) ? '/assets/brands/'+platform+'.svg' : null; },
    morColor(platform) { return colors[platform] || '#64748b'; },
    morStatus(post) {
      if (post?.deliveries?.some(d => d.status === 'uncertain')) return 'Conferir na rede';
      return this.mpStatus?.(post?.status || 'published') || 'Publicada';
    },
    morViews(post) {
      const deliveries = this.morDeliveries(post).filter(d => d.status === 'published' &&
        (this.moNetwork === 'all' || d.platform === this.moNetwork));
      const known = deliveries.filter(d => typeof d.views === 'number' && Number.isFinite(d.views));
      return {value:known.length ? known.reduce((s,d) => s+d.views,0) : null,
        partial:known.length > 0 && known.length < deliveries.length};
    },
    morViewsText(post) { const views=this.morViews(post);return this.moSummaryNumber(views.value)+(views.partial?' · parcial':''); },
    morViewsDate(post) {
      const dates=this.morDeliveries(post).map(d=>d.observed_at).filter(Boolean).sort();
      return dates.length ? 'Última coleta: '+this.moDate(dates[0],true) : 'Aguardando coleta; indisponível não significa zero';
    },
    async morChooseNetwork(platform) {
      if (platform !== 'all' && !this.morNetworks().includes(platform)) return;
      this.morNetwork=platform;
      if (this.moSelected) await this.moOpen(this.moSelected,true);
      this.$nextTick(()=>this.morRenderViewsChart());
    },
    async morLoadMetrics(force = false) {
      const post=this.moSelected;
      if (!post?.key || this.marketingIsMock()) return;
      const key=post.key+':'+this.morDays;
      if (!force && this.morMetricsKey===key) return;
      const seq=++this.morMetricsSeq;
      this.morMetricsKey=key;this.morMetrics=null;this.moInsightsLoading=true;this.moInsightsError='';
      this.morDestroyViewsChart();
      try {
        const result=await this.apiGet('/admin/api/marketing/organic/results/'+encodeURIComponent(post.key)+
          '/metrics?days='+this.morDays+(force?'&refresh=true':''));
        if (seq!==this.morMetricsSeq || this.moSelected?.key!==post.key || this.marketingIsMock()) return;
        this.morMetrics=result;
        // Atualiza o total da lista com a mesma consulta exibida no card.
        for (const row of this.moData?.rows || []) if(row.key===post.key) {
          for (const delivery of row.deliveries) {
            const network=result.networks.find(n=>identity(n)===identity(delivery));
            if(network) Object.assign(delivery,{views:network.views,observed_at:network.observed_at});
          }
        }
      } catch { if(seq===this.morMetricsSeq)this.moInsightsError='Não foi possível consultar as redes. Tente atualizar.'; }
      finally {
        if(seq===this.morMetricsSeq) {
          this.moInsightsLoading=false;
          this.$nextTick(()=>{lucide.createIcons();this.morRenderViewsChart();});
        }
      }
    },
    morHistoryDates() {
      const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo'}).format(new Date());
      const end=Date.parse(today+'T12:00:00Z'), count=Number(this.morDays);
      return Array.from({length:count},(_,i)=>new Date(end-(count-1-i)*86400000).toISOString().slice(0,10));
    },
    morHistorySeries() {
      const dates=this.morHistoryDates(), history=this.morMetrics?.history || [];
      return this.morNetworkCards().map(network=>({platform:network.platform,
        points:dates.map(date=> {
          const row=history.find(r=>r.date===date && identity(r)===identity(network));
          return row && typeof row.views==='number' && Number.isFinite(row.views) ? row.views : null;
        })}));
    },
    morHasHistory() { return this.morHistorySeries().some(s=>s.points.some(v=>v!==null)); },
    morHistoryNotice() {
      if(!this.morMetrics?.history_ready)return 'Histórico indisponível. As métricas atuais continuam acessíveis.';
      if(!this.morHasHistory())return 'O histórico começa na primeira coleta. Nenhum valor anterior será estimado.';
      if(!this.morHistorySeries().some(s=>s.points.filter(v=>v!==null).length>1))return 'Primeira coleta registrada. O gráfico ganhará novos pontos nos próximos dias.';
      return 'Acumulado observado em cada dia. Dias sem coleta ficam sem ponto; não há interpolação.';
    },
    morDestroyViewsChart() { if(viewsChart){viewsChart.destroy();viewsChart=null;} },
    morRenderViewsChart() {
      this.morDestroyViewsChart();
      const canvas=this.$refs.morViewsChart;
      if(!canvas || this.moAnalysisTab!=='metrics' || !this.moSelected || this.moDetailLoading || !this.morHasHistory() || typeof Chart==='undefined')return;
      viewsChart=new Chart(canvas,{type:'line',data:{
        labels:this.morHistoryDates().map(date=>new Date(date+'T12:00:00Z').toLocaleDateString('pt-BR',{day:'2-digit',month:'short',timeZone:'America/Sao_Paulo'})),
        datasets:this.morHistorySeries().map(series=>({label:names[series.platform],data:series.points,
          borderColor:colors[series.platform],backgroundColor:colors[series.platform],pointRadius:4,borderWidth:2.5,tension:0,spanGaps:false})),
      },options:{responsive:true,maintainAspectRatio:false,animation:false,interaction:{intersect:false,mode:'index'},
        plugins:{legend:{position:'top',align:'end',labels:{usePointStyle:true,boxWidth:8}},
          tooltip:{callbacks:{label:item=>item.dataset.label+': '+this.moSummaryNumber(item.parsed.y)+' visualizações acumuladas'}}},
        scales:{x:{grid:{color:'#edf1f5'},ticks:{maxTicksLimit:7,maxRotation:0}},y:{beginAtZero:true,ticks:{precision:0},grid:{color:'#edf1f5'}}}}});
    },
    morClose() {
      ++this.morMetricsSeq;this.morMetricsKey='';this.morMetrics=null;this.morNetwork='all';this.morSendingOpen=false;
      this.moInsightsLoading=false;this.mpReconciliation=null;this.morDestroyViewsChart();
    },
    morStopRefresh() { clearTimeout(this.morPollTimer);this.morPollTimer=null; },
    morScheduleRefresh() {
      this.morStopRefresh();
      if(this.marketingIsMock() || this.currentPage!=='marketing' || this.marketingTab!=='comentarios' || this.moView!=='publications')return;
      if((this.moData?.rows || []).some(row=>row.status==='publishing'))this.morPollTimer=setTimeout(()=>{
        if(this.currentPage==='marketing' && this.marketingTab==='comentarios' && this.moView==='publications')void this.moLoad();
      },15000);
    },
    morPublisherPost() {
      const post=this.moSelected;
      return post?.publisher_id ? {...post,id:post.publisher_id,
        deliveries:post.deliveries.map(d=>({...d,provider_id:d.post_id}))} : null;
    },
    async morRetry() {
      const post=this.morPublisherPost();
      if(!post || !post.deliveries.some(d=>d.status==='failed'))return;
      if(!this.mpConfig)await this.mpLoad(true);
      if(this.mpConfig?.sending)await this.mpAction(post,'retry');
    },
    async morReloadAfterAction() {
      if(this.moView!=='publications')return;
      const selected=this.moSelected;
      await this.moLoad();
      if(selected?.key && this.moSelected?.key===selected.key)await this.moOpen(selected,true);
    },
  };
};
