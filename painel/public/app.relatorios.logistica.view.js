window.PAINEL_MODULES=window.PAINEL_MODULES||{};
window.PAINEL_MODULES.relatoriosLogisticaView=function(){return {
  get rlogUnapplied(){return !!this.rlog.data&&this.rlogQuery(this.rlog.data.filters,'overview')!==this.rlogQuery(null,'overview');},
  get rlogSelected(){return(this.rlog.data?.trips||[]).find(row=>row.id===this.rlog.selected)||null;},
  get rlogRows(){const data=this.rlog.data;return this.rlog.tab==='deliveries'?(data?.deliveries||[]):this.rlog.tab==='costs'?(data?.costs||[]):(data?.trips||[]);},
  get rlogVisibleRows(){return this.rlogRows.slice(this.rlog.tab==='overview'?0:(this.rlog.page-1)*25,this.rlog.tab==='overview'?4:this.rlog.page*25);},
  get rlogSelectedCosts(){return(this.rlog.data?.expenses||[]).filter(row=>row.trip_id===this.rlog.selected);},
  get rlogChart(){
    const rows=this.rlog.data?.daily||[],size=Math.max(1,Math.ceil(rows.length/14)),groups=[];
    for(let i=0;i<rows.length;i+=size){const chunk=rows.slice(i,i+size);groups.push({day:chunk[0].day,to:chunk.at(-1).day,
      delivered:chunk.reduce((n,r)=>n+r.delivered,0),occurrences:chunk.reduce((n,r)=>n+r.occurrences,0)});}
    const max=Math.max(1,...groups.map(r=>Math.max(r.delivered,r.occurrences)));
    return groups.map(row=>({...row,height:row.delivered/max*100,occurrenceHeight:row.occurrences/max*100,
      label:row.day.slice(8,10)+'/'+row.day.slice(5,7),title:this.rpDate(row.day)+(row.day!==row.to?' a '+this.rpDate(row.to):'')+': '+row.delivered+' concluídas; '+row.occurrences+' ocorrências'}));
  },
  rlogStatus(value){return({open:'Aberta',closed:'Encerrada',delivered:'Entregue',failed:'Não entregue',cancelled:'Cancelado',pending:'Pendente',
    linked:'Vinculada',legacy:'Legado',rejected:'Rejeitado',reconciled:'Conciliada',divergent:'Divergência',financial_pending:'Conciliação pendente',occurrences:'Com ocorrências'})[value]||value;},
  rlogTime(value){return value?new Date(value).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',dateStyle:'short',timeStyle:'short'}):'—';},
  rlogHour(value){return value?new Date(value).toLocaleTimeString('pt-BR',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit'}):'Em andamento';},
  rlogDuration(value){return value==null?'Duração não informada':Math.floor(value/60)+'h'+String(value%60).padStart(2,'0');},
  rlogKm(value){return value==null?'Não informado':Number(value).toLocaleString('pt-BR',{maximumFractionDigits:1})+' km';},
  rlogCategory(value){return({combustivel:'Combustível',pedagio:'Pedágio',estacionamento:'Estacionamento',manutencao:'Manutenção',alimentacao:'Alimentação',comprovante:'Comprovante',outros:'Outros'})[value]||String(value||'Despesa').replaceAll('_',' ');},
  rlogCostState(row){return row.missing_expense?'Despesa removida':row.state==='pending'?'Aguardando aprovação':this.rlogStatus(row.state);},
  get rlogPeriodLabel(){return this.rlog.data?this.rpDate(this.rlog.data.filters.from)+' a '+this.rpDate(this.rlog.data.filters.to):'';},
};};
