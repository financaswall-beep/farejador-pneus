window.PAINEL_MODULES=window.PAINEL_MODULES||{};
window.PAINEL_MODULES.relatoriosFaltasView=function(){return{
  get rfalUnapplied(){return !!this.rfal.data&&this.rfalQuery(this.rfal.data.filters,this.rfal.data.filters.view)!==this.rfalQuery();},
  get rfalStores(){const all=this.rfal.data?.stores||[],q=this.rfal.storeSearch.trim().toLocaleLowerCase('pt-BR');
    if(this.rfal.allStores)return all.filter(s=>(s.name+' '+(s.city||'')).toLocaleLowerCase('pt-BR').includes(q));
    const rows=all.slice(0,5),selected=all.find(s=>s.id===this.rfal.store);if(selected&&!rows.includes(selected))rows.splice(4,1,selected);return rows;},
  get rfalConsultation(){return this.rfal.data?.consultations.find(c=>c.id===this.rfal.selected)||null;},
  get rfalDetailMeasure(){return this.rfal.data?.measures.find(m=>m.key===this.rfalConsultation?.measure_key)||this.rfal.data?.selected_measure||null;},
  get rfalRows(){return this.rfal.tab==='potential'?this.rfal.data?.opportunities||[]:this.rfal.tab==='consultations'?this.rfal.data?.consultations||[]:this.rfal.data?.measures||[];},
  get rfalVisible(){return this.rfalRows.slice(this.rfal.tab==='overview'?0:(this.rfal.page-1)*20,this.rfal.tab==='overview'?6:this.rfal.page*20);},
  get rfalRecent(){return(this.rfal.data?.consultations||[]).slice(0,3);},
  get rfalPotential(){const d=this.rfal.data;if(!d)return null;const rows=d.opportunities,priced=rows.filter(o=>o.reference);return{amount:priced.length?priced.reduce((n,o)=>n+Math.round(o.reference.amount*100),0)/100:null,opportunities:rows.length,unpriced:rows.length-priced.length,priced:priced.length};},
  rfalMoney(value){return value==null?'Sem referência':this.rpMoney(value);},
  rfalTime(value){return value?new Date(value).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',dateStyle:'short',timeStyle:'short'}):'—';},
  rfalStock(value){return value==null?'Não informado':value===0?'Zerado':this.rpNumber(value)+' un.';},
  rfalOutcome(row){return row?.available_elsewhere?'Havia em outra loja':'Sem opção nas lojas consultadas';},
  rfalScope(row){const f=row?.filters||{};return[f.marca,f.condicao_pneu?this.rpCondition(f.condicao_pneu):'',f.posicao_pneu?({front:'Dianteiro',rear:'Traseiro',both:'Ambos'})[f.posicao_pneu]||f.posicao_pneu:''].filter(Boolean).join(' · ')||'Sem filtro de marca, condição ou posição registrado';},
  rfalPercent(value,total){return total?Math.round(value/total*100):0;},
  rfalPriceRange(p){return !p||p.min==null?'Preço não disponível':p.min===p.max?this.rpMoney(p.min):this.rpMoney(p.min)+' a '+this.rpMoney(p.max);},
};};
