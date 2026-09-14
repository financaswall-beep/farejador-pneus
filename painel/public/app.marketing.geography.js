window.PAINEL_MODULES=window.PAINEL_MODULES||{};
window.PAINEL_MODULES.marketingGeography=function(){return {
  mgData:null,mgLoading:false,mgError:'',mgSeq:0,mgTarget:40,mgCampaign:'all',mgRegion:'all',mgSelected:'',mgSelectedCampaign:'',
  mgSearch:'',mgInfo:false,mgBusy:false,mgNotice:'',mgPage:1,
  async loadMarketingGeography(){
    const seq=++this.mgSeq,period=this.marketingPeriod;
    const target=Number(this.mgTarget);if(!Number.isFinite(target)||target<=0||target>10000){this.mgLoading=false;this.mgData=null;this.mgError='Informe uma meta entre R$ 0,01 e R$ 10.000.';return;}
    this.mgLoading=true;this.mgError='';this.mgNotice='';this.mgPlanOpen=false;
    try{
      const data=this.marketingIsMock()?marketingGeographyMockPayload(period,target):await this.apiGet(`/admin/api/marketing/geography?period=${period}&target=${target}`);
      if(seq!==this.mgSeq||period!==this.marketingPeriod||target!==Number(this.mgTarget))return;
      this.mgData=data;
      if(!(data.regions||[]).some(r=>r.name===this.mgRegion))this.mgRegion='all';
      if(!(data.catalog||[]).some(c=>c.id===this.mgCampaign))this.mgCampaign='all';
      this.mgReconcile();
    }catch(e){if(seq===this.mgSeq){this.mgData=null;this.mgError=String(e?.message||'').includes('geography_migration_required')?
      'A estrutura desta tela ainda precisa da migration 0229. Os outros módulos continuam disponíveis.':'Não foi possível consultar Geografia e demanda. Tente novamente.';}}
    finally{if(seq===this.mgSeq){this.mgLoading=false;this.$nextTick(()=>lucide.createIcons());}}
  },
  mgRecords(){return (this.mgData?.records||[]).filter(r=>this.mgCampaign==='all'||r.id===this.mgCampaign);},
  mgRegions(){
    const records=this.mgRecords();
    const groups=this.mgCampaign==='all'?(this.mgData?.regions||[]):records.map(r=>({name:r.region,totals:r.totals,previous:r.previous,campaign_ids:[r.id]}));
    return groups.map(g=>{
      const campaigns=records.filter(r=>r.region===g.name);
      const priority={increase:0,pause_offer:1,review:2,maintain:3,wait:4};
      campaigns.sort((a,b)=>priority[a.decision]-priority[b.decision]||a.name.localeCompare(b.name,'pt-BR'));
      const decision=campaigns.some(c=>c.decision==='increase')?'increase':campaigns.some(c=>c.decision==='pause_offer')?'pause_offer':campaigns[0]?.decision||'wait';
      const states=campaigns.map(c=>c.availability.state);
      const availability=states.length&&states.every(s=>s==='available')?'available':states.some(s=>s==='partial'||s==='unavailable')?'partial':'unknown';
      return {...g,campaigns,decision,availability};
    }).sort((a,b)=>({increase:0,pause_offer:1,review:2,maintain:3,wait:4}[a.decision]-{increase:0,pause_offer:1,review:2,maintain:3,wait:4}[b.decision])||a.name.localeCompare(b.name,'pt-BR'));
  },
  mgFiltered(){const q=this.mgSearch.trim().toLocaleLowerCase('pt-BR');return this.mgRegions().filter(g=>(this.mgRegion==='all'||g.name===this.mgRegion)&&(!q||`${g.name} ${g.campaigns.map(c=>c.name).join(' ')}`.toLocaleLowerCase('pt-BR').includes(q)));},
  mgPageRows(){return this.mgFiltered().slice((this.mgPage-1)*10,this.mgPage*10);},
  mgPageCount(){return Math.max(1,Math.ceil(this.mgFiltered().length/10));},
  mgReconcile(){
    this.mgPage=Math.min(this.mgPage,this.mgPageCount());const rows=this.mgPageRows();
    if(!rows.some(r=>r.name===this.mgSelected))this.mgSelected=rows[0]?.name||'';
    const campaigns=this.mgSelectedRegion()?.campaigns||[];
    if(!campaigns.some(c=>c.id===this.mgSelectedCampaign))this.mgSelectedCampaign=campaigns[0]?.id||'';
    this.$nextTick(()=>lucide.createIcons());
  },
  mgFiltersChanged(){this.mgPage=1;this.mgReconcile();},
  mgSelect(row){this.mgSelected=row.name;this.mgSelectedCampaign=row.campaigns[0]?.id||'';this.$nextTick(()=>lucide.createIcons());},
  mgSelectedRegion(){return this.mgFiltered().find(r=>r.name===this.mgSelected)||null;},
  mgSelectedRecord(){return this.mgSelectedRegion()?.campaigns.find(c=>c.id===this.mgSelectedCampaign)||null;},
  mgMoney(v){return v==null?'—':this.formatCurrency(Number(v));},
  mgNumber(v){return v==null?'—':Number(v).toLocaleString('pt-BR',{maximumFractionDigits:2});},
  mgPercent(v){return v==null?'—':this.mgNumber(v)+'%';},
  mgCondition(v){return {novo:'Novo',nova:'Novo',meia_vida:'Meia-vida',usado:'Meia-vida',seminovo:'Seminovo'}[v]||v;},
  mgDecision(id){return {increase:'Testar aumento',maintain:'Manter',review:'Revisar investimento',pause_offer:'Revisar oferta sem estoque',wait:'Aguardar dados'}[id]||'Aguardar dados';},
  mgDecisionIcon(id){return {increase:'trending-up',maintain:'equal',review:'chart-no-axes-combined',pause_offer:'pause',wait:'clock-3'}[id]||'clock-3';},
  mgAvailability(id){return {available:'Oferta atendida',partial:'Estoque parcial',unavailable:'Sem estoque',unknown:'A confirmar'}[id]||'A confirmar';},
  mgLearning(){const value=this.mgSelectedRecord()?.meta?.learning;return value==='SUCCESS'?'Concluído':value==='LEARNING'?'Em aprendizado':value==='FAIL'?'Aprendizado limitado':value?'Acompanhar na Meta':'Não informado pela Meta';},
  mgConversionDelta(){const c=this.mgSelectedRegion();return c?.totals.conversion!=null&&c?.previous.conversion!=null?Math.round((c.totals.conversion-c.previous.conversion)*100)/100:null;},
  mgChange(field){const b=this.mgSelectedRecord()?.budget_change;if(!b)return null;const before=b.before[field],after=b.after[field];return before!=null&&after!=null&&before>0?(after-before)/before*100:null;},
  mgBudgetChangeReady(){const b=this.mgSelectedRecord()?.budget_change;return b&&b.before.spend!=null&&b.after.spend!=null&&b.before.sales!=null&&b.after.sales!=null;},
  mgGauge(){const c=this.mgSelectedRegion()?.totals.cpa;if(c==null)return '0%';return Math.min(100,Math.max(0,c/(Number(this.mgTarget)*1.5)*100))+'%';},
  mgBelowTarget(){const c=this.mgSelectedRegion()?.totals.cpa;return c==null?'Custo regional indisponível':c<=this.mgTarget?`${this.mgNumber((1-c/this.mgTarget)*100)}% abaixo da meta`:`${this.mgNumber((c/this.mgTarget-1)*100)}% acima da meta`;},
  mgMiniLine(field){const d=this.mgSelectedRecord()?.diagnostics;const a=d?.previous?.[field],b=d?.current?.[field];if(a==null||b==null)return '';const max=Math.max(a,b,0.01)*1.25;return `6,${36-a/max*28} 114,${36-b/max*28}`;},
  mgFatigueText(){const d=this.mgSelectedRecord()?.diagnostics;if(!d?.current||!d?.previous)return 'Dados adicionais indisponíveis.';return 'Frequência e CTR são da campanha, não da cidade. Dois períodos comparáveis.';},
  mgViewCampaign(){const c=this.mgSelectedRecord();if(!c)return;this.marketingSetTab('campanhas');this.openMarketingCampaignDetail({id:c.id,platform_id:c.id,name:c.name,channel:'meta'});},
  mgExport(){
    const rows=this.mgFiltered();if(!rows.length)return;
    const cell=v=>`"${String(v??'').replace(/^[=+@-]/,"'$&").replace(/"/g,'""')}"`;
    const content=[['Região','Campanhas','Gasto identificado','Vendas atribuídas','Margem após anúncios','Custo por venda','Conversas identificadas','Conversas com venda','Conversão %','Indicação'],
      ...rows.map(r=>[r.name,r.campaigns.map(c=>c.name).join(' | '),r.totals.spend,r.totals.sales,r.totals.margin,r.totals.cpa,r.totals.conversations,r.totals.converted,r.totals.conversion,this.mgDecision(r.decision)])]
      .map(r=>r.map(cell).join(';')).join('\r\n');
    const url=URL.createObjectURL(new Blob(['\uFEFF'+content],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=`geografia-${this.marketingPeriod}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  },
};};
