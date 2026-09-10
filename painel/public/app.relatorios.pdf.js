// PDF vetorial A4, sem serviço externo. Mesmo snapshot e filtros do relatório.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.relatoriosPdf = function () {
  const {fit,text,rect,rule,green,muted,wrap,build}=window.REPORT_PDF;
  return {
    rpPdfBytes(report,tab='overview') {
      const f=report.filters,m=this.rpMoney.bind(this),condition=this.rpCondition.bind(this);
      const source=tab==='sales'?report.sales.rows:tab==='products'?report.products:report.measures;
      if(source.length>1000)throw Error('Para PDF, reduza os filtros a até 1.000 linhas. O CSV permite um relatório maior.');
      const filters=[this.rpDate(f.from)+' a '+this.rpDate(f.to),f.channel==='all'?'Atacado e varejo':f.channel,
        f.brand||'Todas as marcas',f.condition?condition(f.condition):'Todas as condições',f.measure?'Busca: '+f.measure:''].filter(Boolean).join(' / ');
      const filterLines=wrap(filters);
      const contents=[];
      const header=(title,page)=>{
        let out=rect(0,509,842,86,green)+text('FAREJADOR / MATRIZ',30,566,12,true,'1 1 1')+text(title,30,539,20,true,'1 1 1');
        out+=text('Gerado em '+new Date(report.generated_at).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}),568,561,8,false,'1 1 1');
        filterLines.forEach((line,i)=>{out+=text(line,30,495-i*10,7,false,muted);});
        out+=rule(32)+text('Valores dos itens após descontos, sem frete. Custos registrados na venda. Antes das despesas.',30,20,7,false,muted)+text('Página '+page,759,20,8,false,muted);
        return out;
      };
      let cover=header('Vendas da Matriz',1),s=report.summary;
      const kpis=[['Vendas confirmadas',m(s.revenue)],['Margem bruta',report.can_view_costs?m(s.margin):'Restrita'],['Pneus vendidos',this.rpNumber(s.tires)],['Ticket médio do recorte',m(s.ticket)]];
      kpis.forEach(([label,value],i)=>{const x=30+i*198;cover+=rect(x,393,188,62,'0.95 0.98 0.96')+text(label,x+10,436,8,false,muted)+text(value,x+10,410,20,true,green);});
      cover+=text(s.orders+' vendas no recorte. Serviços não entram na contagem de pneus.',30,378,8,false,muted);
      if(s.pending_cost_lines)cover+=text(s.pending_cost_lines+' item(ns) sem custo. Receita com custo pendente: '+m(s.pending_cost_revenue)+'.',30,363,9,true,'0.58 0.36 0.08');
      cover+=text('EVOLUÇÃO DAS VENDAS',30,335,11,true)+text('Período selecionado',330,335,8,false,green);
      if(report.comparison){cover+=text('Comparação',435,335,8,false,'0.65 0.48 0.17');cover+=text('Comparação: '+this.rpDate(report.comparison.from)+' a '+this.rpDate(report.comparison.to),30,318,8,false,muted);}
      const step=Math.max(1,Math.ceil(report.daily.length/24)),bars=[];
      for(let i=0;i<report.daily.length;i+=step){const rows=report.daily.slice(i,i+step);bars.push({day:rows[0].day,revenue:rows.reduce((n,r)=>n+r.revenue,0),previous:rows.reduce((n,r)=>n+(r.previous||0),0)});}
      const max=Math.max(1,...bars.flatMap(row=>[row.revenue,row.previous])),width=490/Math.max(1,bars.length);
      cover+=text(m(max),30,298,7,false,muted);
      bars.forEach((bar,i)=>{const x=45+i*width;cover+=rect(x,138,width*.35,bar.revenue/max*145,green);if(report.comparison)cover+=rect(x+width*.40,138,width*.35,bar.previous/max*145,'0.82 0.66 0.35');if(i===0||i%Math.ceil(bars.length/7)===0||i===bars.length-1)cover+=text(bar.day.slice(8)+'/'+bar.day.slice(5,7),x,123,7,false,muted);});
      cover+=text('POR CANAL',575,335,11,true);
      report.channels.forEach((channel,i)=>{const y=295-i*72;cover+=text(channel.channel==='atacado'?'Atacado':'Varejo',575,y,10,true)+text(m(channel.revenue),575,y-19,14,true,green)+rect(575,y-35,225,9,'0.92 0.95 0.95')+rect(575,y-35,s.revenue?225*channel.revenue/s.revenue:0,9,i?'0.78 0.61 0.27':green);});
      cover+=text('Varejo: data de criação. Atacado: data da venda. Apenas quantidades aceitas em transferências acertadas.',30,82,8,false,muted);
      cover+=text('A comparação usa os mesmos filtros. No mês, compara os mesmos dias do mês anterior.',30,65,8,false,muted);
      contents.push(cover);
      const title=tab==='sales'?'Vendas do recorte':tab==='products'?'Produtos e marcas':'Medidas e itens vendidos';
      for(let start=0;start<Math.max(1,source.length);start+=17){
        let out=header(title,contents.length+1);out+=rect(30,436,782,25,'0.94 0.96 0.96');
        const columns=tab==='sales'?[['Venda / canal',38],['Data',270],['Itens',345],['Vendas',425]]:[['Medida / item',38],['Marca / condição',205],['Qtd.',365],['Vendas',425]];
        if(report.can_view_costs)columns.push(['Custo histórico',555],['Margem bruta',690]);
        columns.forEach(([label,x])=>{out+=text(label,x,445,8,true,muted);});
        source.slice(start,start+17).forEach((row,i)=>{
          const y=418-i*21;
          const cols=tab==='sales'?[[this.rpSaleLabel(row)+' / '+row.channel,38],[this.rpDate(row.day),270],[row.units,345]]:
            [[fit(row.measure,28),38],[fit(tab==='products'?row.brand+' / '+condition(row.condition):'Variantes do recorte',26),205],[row.units,365]];
          cols.push([m(row.revenue),425]);if(report.can_view_costs)cols.push([m(row.cost),555],[m(row.margin),690]);
          cols.forEach(([value,x])=>{out+=text(value,x,y,8,x===38);});out+=rule(y-8);
        });
        if(!source.length)out+=text('Nenhuma venda neste recorte.',38,416,10,false,muted);
        out+=text((source.length?start+1:0)+' a '+Math.min(start+17,source.length)+' de '+source.length+' linhas. Totais do recorte na primeira página.',30,48,8,false,muted);
        contents.push(out);
      }
      return build(contents);
    },
  };
};
