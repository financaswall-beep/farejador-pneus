window.PAINEL_MODULES=window.PAINEL_MODULES||{};
window.PAINEL_MODULES.relatoriosEstoquePdf=function(){return {
  rstPdfBytes(report,tab='overview'){
    const {fit,text,rect,rule,green,muted,wrap,build}=window.REPORT_PDF;
    const groups=report.groups.filter(row=>tab!=='replenishment'||(row.suggested??0)>0),events=tab==='movements',rows=events?report.movements.rows:groups;
    if(rows.length>1000)throw Error('O PDF comporta até 1.000 linhas. Reduza os filtros ou use CSV.');
    const f=report.filters,s=report.summary,header=(title,page)=>{
      let out=rect(0,509,842,86,green)+text('FAREJADOR / MATRIZ',30,566,12,true,'1 1 1')+text(title,30,539,20,true,'1 1 1');
      out+=text('Estoque consultado em '+this.rstTime(report.as_of),530,565,8,false,'1 1 1');
      const filters=['Base do giro: '+f.days+' dias ('+this.rpDate(report.from)+' a '+this.rpDate(report.to)+')',
        f.condition?this.rpCondition(f.condition):'Todas as condições',f.status==='all'?'Todas as situações':this.rstStatus(f.status),f.measure||'',
        events?'Movimentos: '+({all:'todos',in:'entradas',out:'saídas',unchanged:'sem mudança de saldo'})[f.movement]:'',
        events?'Origem: '+({all:'todas',purchase:'compras',sale:'vendas',return:'devoluções',adjustment:'ajustes',other:'outras'})[f.source]:''].filter(Boolean).join(' / ');
      wrap(filters,115).forEach((line,i)=>{out+=text(line,30,493-i*9,8,false,muted);});
      return out+rule(32)+text('Saldos atuais; giro por saídas físicas de vendas menos devoluções. Não representa saldo histórico.',30,20,7,false,muted)+text('Página '+page,761,20,8,false,muted);
    };
    let cover=header('Estoque e reposição',1);
    [['Disponíveis',s.available],['Reservados',s.reserved],['A caminho',s.incoming],['Grupos para repor',s.replenish]].forEach(([label,value],i)=>{
      const x=30+i*198;cover+=rect(x,385,188,68,'0.94 0.98 0.96')+text(label,x+10,432,9,false,muted)+text(this.rpNumber(value),x+10,400,24,true,green);
    });
    cover+=text('COMO A REPOSIÇÃO É CALCULADA',30,352,12,true)+text('Mínimo - disponível - compras em trânsito, limitado a zero.',30,330,10,false,muted)
      +text('Mínimo definido por medida e condição, somando as marcas. Sem mínimo não há sugestão automática.',30,312,9,false,muted)
      +text(s.suggested+' pneus sugeridos / '+s.no_minimum+' grupos sem mínimo / '+s.physical+' pneus físicos.',30,290,10,true,green);
    cover+=text('PRIORIDADES DO ESTOQUE',30,257,12,true);
    groups.slice(0,5).forEach((row,i)=>{const y=229-i*30;cover+=text(fit(row.measure+' / '+this.rpCondition(row.condition),28),30,y,10,true)
      +text('Disponível '+row.available+' / a caminho '+row.incoming,242,y,9,false,muted)
      +text(row.suggested==null?'Sem mínimo':'Repor '+row.suggested+' pneus',520,y,10,true,green)+text(this.rstStatus(row.status),665,y,8,false,muted)+rule(y-12);});
    cover+=text('Cobertura é uma estimativa pelo giro do período e considera apenas o disponível atual.',30,55,9,false,muted);
    const pages=[cover],title=events?'Movimentações do estoque':tab==='replenishment'?'Reposição sugerida':'Produtos e disponibilidade';
    const columns=events?[['Data / origem',38],['Produto / marca / condição',250],['Antes',610],['Variação',685],['Depois',760]]:
      [['Medida / condição',38],['Físico',258],['Reserva',324],['Disponível',398],['A caminho',481],['Giro',568],['Mínimo',626],['Repor',691],['Cobertura',754]];
    for(let start=0;start<Math.max(1,rows.length);start+=12){
      let out=header(title,pages.length+1)+rect(30,420,782,24,'0.94 0.96 0.96');columns.forEach(([label,x])=>{out+=text(label,x,429,8,true,muted);});
      rows.slice(start,start+12).forEach((row,index)=>{
        const y=400-index*28;
        const cells=events?[[this.rstTime(row.at),38],[fit(row.measure+' / '+row.brand+' / '+this.rpCondition(row.condition),51),250],[row.before,610],[this.rstSigned(row.delta),685],[row.after,760]]:
          [[fit(row.measure+' / '+this.rpCondition(row.condition),33),38],[row.physical,258],[row.reserved,324],[row.available,398],[row.incoming,481],[row.sold,568],[row.minimum??'—',626],[row.suggested??'—',691],[row.coverage_days==null?'Sem giro':String(row.coverage_days).replace('.',',')+' d',754]];
        cells.forEach(([value,x])=>{out+=text(value,x,y,8,x===38);});if(events)out+=text(fit(row.label,35),38,y-10,7,false,muted);out+=rule(y-17);
      });
      if(!rows.length)out+=text('Nenhum registro neste recorte.',38,396,10,false,muted);
      out+=text((rows.length?start+1:0)+' a '+Math.min(start+12,rows.length)+' de '+rows.length+' registros.',30,47,8,false,muted);pages.push(out);
    }return build(pages);
  },
};};
