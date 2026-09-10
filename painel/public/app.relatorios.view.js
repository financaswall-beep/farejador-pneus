window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.relatoriosView = function () {
  return {
    get rpUnapplied() {return !!this.rp.data&&this.rpQuery(this.rp.data.filters)!==this.rpQuery();},
    get rpLibrary() {
      return [
        {id:'vendas',group:'VENDAS',label:'Vendas da Matriz',description:'Atacado e varejo',icon:'files',module:'vendas'},
        {id:'compras',group:'OPERAÇÃO',label:'Compras e fornecedores',description:'Valores, produtos e fornecedores',icon:'shopping-cart',module:'compras'},
        {id:'estoque',group:'OPERAÇÃO',label:'Estoque e reposição',description:'Disponibilidade, giro e reposição',icon:'boxes',module:'estoque'},
        {id:'logistica',group:'OPERAÇÃO',label:'Entregas e rotas',description:'Abrir Logística',icon:'truck',module:'logistica',page:'logistica'},
        {id:'financeiro',group:'FINANCEIRO',label:'Resultado, caixa e títulos',description:'Abrir Financeiro',icon:'wallet',module:'financeiro',page:'financeiro'},
        {id:'rede',group:'REDE E BOT',label:'Desempenho dos parceiros',description:'Abrir Rede',icon:'users',module:'rede',page:'rede'},
        {id:'faltas',group:'REDE E BOT',label:'Faltas por loja',description:'Produtos sem disponibilidade',icon:'store',module:'bot',page:'bot'},
        {id:'demanda',group:'REDE E BOT',label:'Demanda por município',description:'Origem da procura',icon:'map-pin',module:'bot',page:'bot'},
      ].filter(item=>this.hasPanelModule(item.module));
    },
    get rpLibraryGroups() {
      const query=this.rp.librarySearch.trim().toLocaleLowerCase('pt-BR'),groups=[];
      for(const item of this.rpLibrary.filter(item=>(item.label+' '+item.description).toLocaleLowerCase('pt-BR').includes(query))) {
        let group=groups.find(row=>row.name===item.group);
        if(!group){group={name:item.group,items:[]};groups.push(group);}group.items.push(item);
      }
      return groups;
    },
    rpMoney(value) {return value==null?'Pendente':Number(value).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});},
    rpNumber(value) {return Number(value||0).toLocaleString('pt-BR');},
    rpDate(value) {return value?new Date(value+'T12:00:00Z').toLocaleDateString('pt-BR',{timeZone:'UTC'}):'—';},
    rpCondition(value) {return ({novo:'Novo',meia_vida:'Meia-vida',remold:'Remold',unknown:'Sem condição registrada'})[value]||'Sem condição registrada';},
    rpDelta(now,old,percent=true) {
      if(!this.rp.data?.comparison)return '';
      if(percent&&(!old||old<=0))return now>0?'Sem base anterior':'Sem variação';
      const delta=percent?(now-old)/old*100:now-old;
      return (delta>0?'↑ ':delta<0?'↓ ':'')+Math.abs(delta).toLocaleString('pt-BR',{maximumFractionDigits:percent?1:0})+(percent?'%':' pneus');
    },
    get rpFiltersLabel() {
      const f=this.rp.data?.filters;if(!f)return '';
      return [this.rpDate(f.from)+' a '+this.rpDate(f.to),f.channel==='all'?'Atacado e varejo':f.channel==='atacado'?'Atacado':'Varejo',
        f.brand||'Todas as marcas',f.condition?this.rpCondition(f.condition):'Todas as condições',f.measure||''].filter(Boolean).join(' · ');
    },
    get rpChart() {
      const days=this.rp.data?.daily||[],size=Math.max(1,Math.ceil(days.length/31)),buckets=[];
      for(let index=0;index<days.length;index+=size) {
        const rows=days.slice(index,index+size),revenue=rows.reduce((n,row)=>n+row.revenue,0);
        const previous=rows.some(row=>row.previous!==null)?rows.reduce((n,row)=>n+(row.previous||0),0):null;
        buckets.push({day:rows[0].day,last:rows.at(-1).day,revenue,previous,
          label:rows[0].day.slice(8)+'/'+rows[0].day.slice(5,7),
          title:this.rpDate(rows[0].day)+(size>1?' a '+this.rpDate(rows.at(-1).day):'')+': '+this.rpMoney(revenue)+(previous!==null?' · comparação: '+this.rpMoney(previous):'')});
      }
      return buckets;
    },
    get rpChartMax() {return Math.max(1,...this.rpChart.flatMap(row=>[row.revenue,row.previous||0]));},
    get rpMeasures() {return (this.rp.data?.measures||[]).slice(0,6);},
    get rpProducts() {return (this.rp.data?.products||[]).slice((this.rp.productPage-1)*25,this.rp.productPage*25);},
    rpSaleLabel(sale) {return (sale.channel==='atacado'?'ATA-':'VND-')+sale.id.replaceAll('-','').slice(-8).toUpperCase();},
    rpShare(amount) {return this.rp.data?.summary.revenue?Math.round(amount/this.rp.data.summary.revenue*1000)/10:0;},
  };
};
