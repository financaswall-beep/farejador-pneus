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
  rdemDifference(now,previous){if(now==null||previous==null)return'Sem comparação';const value=now-previous;return(value>0?'+':'')+this.rpNumber(value);},
  rdemChangeTone(now,previous){return now==null||previous==null||now===previous?'neutral':now>previous?'positive':'negative';},
  rdemShortDate(value){return new Date(value+'T12:00:00Z').toLocaleDateString('pt-BR',{day:'2-digit',month:'short',timeZone:'UTC'}).replace(' de ',' ');},
  get rdemEvolution(){
    const data=this.rdem.data;if(!data)return{};
    const unit=({conversations:'conversas',orders:'conversas com pedido',deliveries:'conversas com entrega',shortages:'conversas com falta'})[this.rdem.metric];
    const days=Math.max(1,(Date.parse(data.filters.to)-Date.parse(data.filters.from))/86400000+1),total=this.rdemSeries.reduce((n,r)=>n+r.current,0);
    const range=f=>this.rpDate(f.from)+' a '+this.rpDate(f.to),legend=(f,label,n)=>label+(f.from.slice(0,7)===f.to.slice(0,7)?' · '+new Date(f.from+'T12:00:00Z').toLocaleDateString('pt-BR',{month:'short',timeZone:'UTC'}):'')+' ('+this.rpNumber(n)+')';
    const title=({conversations:'Como a procura evoluiu',orders:'Como os pedidos evoluíram',deliveries:'Como as entregas evoluíram',shortages:'Como as faltas evoluíram'})[this.rdem.metric];
    const peak=this.rdemPeak;
    return{unit,title:title+(this.rdem.city&&this.rdem.city!=='__unknown__'?' em ':' · ')+data.city_name,
      subtitle:unit[0].toUpperCase()+unit.slice(1)+' por '+(this.rdem.grain==='week'?'bloco de 7 dias':'dia')+(data.comparison?' · comparação entre intervalos de igual duração.':'.'),
      currentLegend:legend(data.filters,'Atual',total),previousLegend:data.comparison?legend(data.comparison,'Anterior',this.rdemSeries.reduce((n,r)=>n+(r.previous||0),0)):'',
      average:(total/days).toLocaleString('pt-BR',{maximumFractionDigits:1}),
      peak:peak&&peak.current>0?(this.rdem.metric==='conversations'?'Maior procura: ':'Maior volume: ')+this.rdemShortDate(peak.from)+(peak.to!==peak.from?' a '+this.rdemShortDate(peak.to):'')+' · '+this.rpNumber(peak.current)+' '+unit:'Sem atividade no indicador selecionado.',
      comparison:data.comparison?'Comparação: '+range(data.filters)+' com '+range(data.comparison)+'.':'Comparação desativada. Selecione “Comparar período” para ver as diferenças.',
    };
  },
};};
