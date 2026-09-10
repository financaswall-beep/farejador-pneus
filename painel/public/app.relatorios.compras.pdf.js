window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.relatoriosComprasPdf = function () {
  return {
    rcompPdfBytes(report,tab='overview') {
      const {fit,text,rect,rule,green,muted,wrap,build}=window.REPORT_PDF;
      const m=this.rpMoney.bind(this),s=report.summary,f=report.filters;
      const source=tab==='purchases'?report.purchases.rows:tab==='suppliers'?report.suppliers:report.products;
      if(source.length>1000)throw Error('Para PDF, reduza os filtros a até 1.000 linhas. O CSV permite um relatório maior.');
      const supplier=report.facets.suppliers.find(row=>row.id===f.supplier)?.name||(f.supplier?'Fornecedor selecionado':'Todos os fornecedores');
      const filters=wrap([this.rpDate(f.from)+' a '+this.rpDate(f.to),fit(supplier,65),f.brand||'Todas as marcas',
        f.condition?this.rpCondition(f.condition):'Todas as condições',f.receipt==='all'?'Todos os recebimentos':f.receipt==='received'?'Recebidas':'Em trânsito',f.measure||''].filter(Boolean).join(' / '),105);
      const header=(title,page)=>{
        let out=rect(0,509,842,86,green)+text('FAREJADOR / MATRIZ',30,566,12,true,'1 1 1')+text(title,30,539,20,true,'1 1 1');
        out+=text('Gerado em '+new Date(report.generated_at).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}),568,561,8,false,'1 1 1');
        filters.forEach((line,i)=>{out+=text(line,30,498-i*9,7,false,muted);});
        return out+rule(32)+text('Por data da compra; recebimento e pagamento na posição atual. Canceladas ficam fora.',30,20,7,false,muted)+text('Página '+page,759,20,8,false,muted);
      };
      let cover=header('Compras e fornecedores',1);
      [['Valor comprado',m(s.value)],['Pneus comprados',this.rpNumber(s.quantity)],['Custo médio por pneu',this.rcompCost(s.average_cost)],['Fornecedores',this.rpNumber(s.suppliers)]].forEach(([label,value],i)=>{
        const x=30+i*198;cover+=rect(x,393,188,62,'0.95 0.98 0.96')+text(label,x+10,436,8,false,muted)+text(value,x+10,410,19,true,green);
      });
      cover+=text(s.purchases+' compras / '+s.received+' pneus recebidos / '+s.transit+' em trânsito. Custo com frete e descontos rateados.',30,376,8,false,muted);
      cover+=text('EVOLUÇÃO DO VALOR COMPRADO',30,348,11,true);
      if(report.comparison)cover+=text('Comparação em dourado: '+this.rpDate(report.comparison.from)+' a '+this.rpDate(report.comparison.to),30,333,8,false,muted);
      const step=Math.max(1,Math.ceil(report.daily.length/24)),bars=[];
      for(let i=0;i<report.daily.length;i+=step){const rows=report.daily.slice(i,i+step);bars.push({day:rows[0].day,value:rows.reduce((n,r)=>n+r.value,0),previous:rows.reduce((n,r)=>n+(r.previous||0),0)});}
      const max=Math.max(1,...bars.flatMap(row=>[row.value,row.previous])),width=480/Math.max(1,bars.length);
      cover+=text(m(max),30,313,7,false,muted);
      bars.forEach((bar,i)=>{const x=45+i*width;cover+=rect(x,164,width*.35,bar.value/max*135,green);
        if(report.comparison)cover+=rect(x+width*.4,164,width*.35,bar.previous/max*135,'0.82 0.66 0.35');
        if(i===0||i===bars.length-1||i%Math.ceil(bars.length/7)===0)cover+=text(bar.day.slice(8)+'/'+bar.day.slice(5,7),x,150,7,false,muted);
      });
      cover+=text('DE QUEM COMPRAMOS',565,348,11,true);
      report.suppliers.slice(0,5).forEach((row,i)=>{const y=319-i*35;cover+=text(fit(row.name,25),565,y,8,true)+text(m(row.value),726,y,8,true,green)
        +rect(565,y-12,235,5,'0.92 0.95 0.95')+rect(565,y-12,s.value?235*row.value/s.value:0,5,green);});
      if(report.can_view_payments){cover+=rect(30,74,782,55,'0.96 0.97 0.97')+text('PAGAMENTO DAS COMPRAS INTEIRAS',40,113,9,true)
        +text('Valor integral: '+m(s.full_total),40,90,11,true)+text('Pago: '+m(s.paid),315,90,11,true,green)+text('Em aberto: '+m(s.open),550,90,11,true,'0.60 0.43 0.14');}
      else cover+=text('Pagamentos: acesso financeiro necessário.',30,100,9,false,muted);
      cover+=text(report.item_filtered?'Valores pagos e em aberto são das compras inteiras que contêm os produtos filtrados.':'Quantidades após conferência usam o que foi aceito. Produtos recusados não contam como recebidos.',30,53,8,false,muted);
      const pages=[cover],title=tab==='purchases'?'Compras do recorte':tab==='suppliers'?'Fornecedores do recorte':'Produtos comprados';
      const columns=tab==='purchases'?[['Compra / data',38],['Fornecedor',230],['Pneus',425],['Valor do recorte',485]]:
        tab==='suppliers'?[['Fornecedor',38],['Compras',290],['Pneus',370],['Valor do recorte',460]]:
        [['Medida / marca / condição',38],['Pneus',305],['Recebidos',365],['Em trânsito',435],['Valor',530],['Custo médio',655],['Vs. anterior',755]];
      if(['suppliers','purchases'].includes(tab)&&report.can_view_payments)columns.push(['Pago integral',615],['Aberto integral',722]);
      for(let start=0;start<Math.max(1,source.length);start+=15){
        let out=header(title,pages.length+1)+rect(30,434,782,25,'0.94 0.96 0.96');
        columns.forEach(([label,x])=>{out+=text(label,x,443,8,true,muted);});
        source.slice(start,start+15).forEach((row,i)=>{
          const y=414-i*23;
          const cells=tab==='purchases'?[[this.rcompPurchaseLabel(row)+' / '+this.rpDate(row.day),38],[fit(row.supplier_name,26),230],[row.quantity,425],[m(row.value),485]]:
            tab==='suppliers'?[[fit(row.name,38),38],[row.purchases,290],[row.quantity,370],[m(row.value),460]]:
            [[fit(row.measure+' / '+row.brand+' / '+this.rpCondition(row.condition),47),38],[row.quantity,305],[row.received,365],[row.transit,435],[m(row.value),530],[this.rcompCost(row.average_cost),655],[row.change_pct==null?'Sem base':row.change_pct.toLocaleString('pt-BR')+'%',755]];
          if(['suppliers','purchases'].includes(tab)&&report.can_view_payments)cells.push([m(row.paid),615],[m(row.open),722]);
          cells.forEach(([value,x])=>{out+=text(value,x,y,8,x===38);});out+=rule(y-9);
        });
        if(!source.length)out+=text('Nenhuma compra neste recorte.',38,414,10,false,muted);
        out+=text((source.length?start+1:0)+' a '+Math.min(start+15,source.length)+' de '+source.length+' linhas. Pagamentos são valores integrais das compras.',30,48,8,false,muted);pages.push(out);
      }
      return build(pages);
    },
  };
};
