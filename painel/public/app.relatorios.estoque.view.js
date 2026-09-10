window.PAINEL_MODULES=window.PAINEL_MODULES||{};
window.PAINEL_MODULES.relatoriosEstoqueView=function(){return {
  get rstUnapplied(){return !!this.rst.data&&this.rstQuery(this.rst.data.filters,'overview')!==this.rstQuery(null,'overview');},
  get rstRows(){return(this.rst.data?.groups||[]).filter(row=>this.rst.tab!=='replenishment'||(row.suggested??0)>0);},
  get rstVisibleRows(){return this.rstRows.slice(this.rst.tab==='overview'?0:(this.rst.page-1)*25,this.rst.tab==='overview'?6:this.rst.page*25);},
  get rstSelected(){return(this.rst.data?.groups||[]).find(row=>row.key===this.rst.selected)||null;},
  rstStatus(value){return({zero:'Sem disponível',replenish:'Repor',incoming:'Aguardando chegada',healthy:'Adequado',no_sales:'Sem giro',no_minimum:'Sem mínimo'})[value]||value;},
  rstCoverage(row){return row?.coverage_days==null?'Sem giro para estimar':Number(row.coverage_days).toLocaleString('pt-BR',{maximumFractionDigits:1})+' dias';},
  rstTime(value){return value?new Date(value).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',dateStyle:'short',timeStyle:'short'}):'—';},
  rstSigned(value){return(value>0?'+':'')+this.rpNumber(value);},
  get rstFiltersLabel(){const f=this.rst.data?.filters;return f?['Giro: '+f.days+' dias',f.condition?this.rpCondition(f.condition):'Todas as condições',
    f.status==='all'?'Todas as situações':this.rstStatus(f.status),f.measure].filter(Boolean).join(' · '):'';},
};};
