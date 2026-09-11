window.PAINEL_MODULES=window.PAINEL_MODULES||{};
window.PAINEL_MODULES.relatoriosDemandaView=function(){return{
  get rdemUnapplied(){return !!this.rdem.data&&this.rdemQuery(this.rdem.data.filters)!==this.rdemQuery();},
  get rdemCities(){return this.rdem.data?.cities||[];},
  get rdemRows(){return this.rdem.tab==='measures'?this.rdem.data?.measures||[]:this.rdemCities;},
  get rdemVisible(){return this.rdemRows.slice(this.rdem.tab==='overview'?0:(this.rdem.page-1)*15,this.rdem.tab==='overview'?6:this.rdem.page*15);},
  get rdemScope(){return this.rdem.data?.scope||{conversations:0,orders:0,deliveries:0,shortages:0,conversion:null};},
  get rdemLeader(){return this.rdem.data?.city_options.find(c=>c.key!=='__unknown__'&&c.conversations>0)||null;},
  get rdemBestConversion(){return(this.rdem.data?.city_options||[]).filter(c=>c.key!=='__unknown__'&&c.conversations>0).slice().sort((a,b)=>b.conversion-a.conversion||b.conversations-a.conversations)[0]||null;},
  get rdemMetricLabel(){return this.rdemMetricName(this.rdem.metric);},
  rdemMetricName(key){return({conversations:'Procura',orders:'Com pedido',deliveries:'Com entrega',shortages:'Com falta'})[key]||'Procura';},
  rdemPercent(value,total=null){return value==null?'Sem base':(total===null?value:total?value/total*100:0).toLocaleString('pt-BR',{maximumFractionDigits:1})+'%';},
  rdemWidth(value,total){return Math.min(100,Math.max(0,total?value/total*100:0));},
  rdemDelta(now,previous,pp=false){if(previous==null||now==null)return'Sem comparação';if(!pp&&previous===0)return now===0?'Sem variação':'Sem base anterior';
    const value=pp?now-previous:(now-previous)/previous*100;return(value>0?'+':'')+value.toLocaleString('pt-BR',{maximumFractionDigits:1})+(pp?' p.p.':'%');},
  rdemStock(value){return value==null?'Não informado':value===0?'Zerado':this.rpNumber(value)+' un.';},
  rdemTime(value){return value?new Date(value).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',dateStyle:'short',timeStyle:'short'}):'—';},
  get rdemSeries(){return(this.rdem.tab==='measures'?this.rdem.data?.measure_series:this.rdem.data?.series)||[];},
  get rdemPeak(){return this.rdemSeries.slice().sort((a,b)=>b.current-a.current)[0]||null;},
};};
