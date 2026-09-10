window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.relatoriosComprasView = function () {
  return {
    get rcompUnapplied() {return !!this.rcomp.data&&this.rcompQuery(this.rcomp.data.filters,'overview')!==this.rcompQuery(null,'overview');},
    get rcompSupplierOptions() {
      const rows=this.rcomp.data?.facets.suppliers||[],id=this.rcomp.supplier;
      return id&&!rows.some(row=>row.id===id)?[...rows,{id,name:'Fornecedor selecionado (sem compras no período)'}]:rows;
    },
    rcompChange(value) {return value===null||value===undefined?'Sem base anterior':(value>0?'↑ ':value<0?'↓ ':'')+Math.abs(value).toLocaleString('pt-BR',{maximumFractionDigits:1})+'%';},
    rcompCost(value) {return value==null?'Sem base':this.rpMoney(value);},
    rcompPurchaseLabel(row) {return 'CP-'+row.id.replaceAll('-','').slice(-8).toUpperCase();},
    rcompPaymentLabel(row) {return row.open==null?'Acesso financeiro necessário':row.open===0?'Pago':row.paid>0?'Pago parcialmente':'Em aberto';},
    get rcompProducts() {return (this.rcomp.data?.products||[]).slice(this.rcomp.tab==='overview'?0:(this.rcomp.productPage-1)*25,this.rcomp.tab==='overview'?5:this.rcomp.productPage*25);},
    get rcompSupplierRows() {const search=this.rcomp.supplierSearch.trim().toLocaleLowerCase('pt-BR');return(this.rcomp.data?.suppliers||[]).filter(row=>row.name.toLocaleLowerCase('pt-BR').includes(search));},
    get rcompSuppliers() {return this.rcompSupplierRows.slice((this.rcomp.supplierPage-1)*25,this.rcomp.supplierPage*25);},
    get rcompChart() {
      const days=this.rcomp.data?.daily||[],size=Math.max(1,Math.ceil(days.length/31)),out=[];
      const field=this.rcomp.chart==='received'?'received':'value',old=field==='received'?'previous_received':'previous';
      for(let i=0;i<days.length;i+=size){const rows=days.slice(i,i+size),value=rows.reduce((n,row)=>n+row[field],0);
        const previous=rows.some(row=>row[old]!==null)?rows.reduce((n,row)=>n+(row[old]||0),0):null;
        const format=n=>field==='received'?this.rpNumber(n)+' pneus':this.rpMoney(n);
        out.push({day:rows[0].day,label:rows[0].day.slice(8)+'/'+rows[0].day.slice(5,7),value,previous,
          title:this.rpDate(rows[0].day)+(size>1?' a '+this.rpDate(rows.at(-1).day):'')+': '+format(value)+(previous!==null?' · comparação: '+format(previous):'')});
      }return out;
    },
    get rcompChartMax() {return Math.max(1,...this.rcompChart.flatMap(row=>[row.value,row.previous||0]));},
    get rcompFiltersLabel() {
      const f=this.rcomp.data?.filters;if(!f)return '';
      const supplier=this.rcomp.data.facets.suppliers.find(row=>row.id===f.supplier)?.name;
      return [this.rpDate(f.from)+' a '+this.rpDate(f.to),supplier||(f.supplier?'Fornecedor selecionado':'Todos os fornecedores'),f.brand||'Todas as marcas',
        f.condition?this.rpCondition(f.condition):'Todas as condições',f.receipt==='all'?'Todos os recebimentos':f.receipt==='received'?'Recebidas':'Em trânsito',f.measure||''].filter(Boolean).join(' · ');
    },
  };
};
