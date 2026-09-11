window.PAINEL_MODULES=window.PAINEL_MODULES||{};
window.PAINEL_MODULES.relatoriosDemandaPdf=function(){return{
  rdemPdfBytes(r){const {text,rect,rule,fit,wrap,build,green,muted}=window.REPORT_PDF,f=r.filters;
    const tabs={overview:'Visão geral',cities:'Municípios',measures:'Medidas',evolution:'Evolução'},series=f.view==='measures'?r.measure_series:r.series;
    const header=page=>rect(0,509,842,86,green)+text('FAREJADOR / MATRIZ',30,566,12,true,'1 1 1')+text('Demanda por município / '+tabs[f.view],30,536,22,true,'1 1 1')
      +text(this.rpDate(f.from)+' a '+this.rpDate(f.to)+' / '+fit(r.city_name,70),30,487,10,true)
      +text('Comparação: '+(r.comparison?this.rpDate(r.comparison.from)+' a '+this.rpDate(r.comparison.to):'desativada')+' / Posição: '+this.rdemTime(r.as_of),30,469,9,false,muted)
      +rule(33)+text('Conversas distintas no período. Localização e estoque atuais. Não representa clientes únicos.',30,20,8,false,muted)+text('Página '+page,765,20,8,false,muted);
    let cover=header(1);const metrics=[['Conversas',r.scope.conversations],['Com pedido',r.scope.orders],['Com falta',r.scope.shortages],['Conversão',this.rdemPercent(r.scope.conversion)]];
    metrics.forEach(([label,value],i)=>{const x=30+i*198;cover+=rect(x,371,188,68,'0.94 0.98 0.96')+text(label,x+10,418,9,false,muted)+text(value,x+10,389,23,true,green);});
    const notes=['Município do detalhe: '+r.city_name+'. Busca da lista: '+(f.citySearch||'todos')+'. Busca de medida: '+(f.search||'todas')+'.',
      'Atividade: respostas enviadas do Bot V2, consultas de medidas, faltas, pedidos ou entregas vinculados à conversa.',
      'Cada indicador conta uma vez por conversa no intervalo, na data da primeira ocorrência. Repetições são removidas.',
      'Pedidos criados e entregas realizadas usam suas próprias datas. Pedidos cancelados ficam fora. Conversão = conversas com pedido / conversas.',
      'Uma conversa pode consultar várias medidas. Cada conversa conta uma vez por medida; não somar isso como pessoas.',
      'O município é o último conhecido, inclusive no histórico. Sem município fica separado. Sem estoque cadastrado é diferente de zero.',
      'Estoque físico atual da Matriz, somando marcas e condições, incluindo reservas. Não é a disponibilidade na consulta.',
      'A série atribui cada indicador ao primeiro dia no intervalo; não mostra todos os retornos de uma conversa. Semanas são blocos de 7 dias a partir do início.',
      'A comparação tem o mesmo número de dias. Se o mês anterior for mais curto, usa o intervalo imediatamente anterior de mesma duração.'];
    let y=349;for(const note of notes){for(const line of wrap(note,132)){cover+=text(line,30,y,9,false,muted);y-=13;}y-=8;}const pages=[cover];
    if(f.view!=='cities'&&series.length){let chart=header(2)+text((f.view==='measures'?'Consultas de '+(r.selected_measure?.measure||'nenhuma medida'):this.rdemMetricName(f.metric))+' / '+fit(r.city_name,65),30,437,14,true);
      const top=Math.ceil(Math.max(2,...series.flatMap(d=>[d.current,d.previous||0]))/2)*2,x=i=>60+i*712/Math.max(1,series.length-1),py=v=>158+v/top*218;
      for(const v of [0,top/2,top])chart+=`0.87 0.92 0.9 RG 0.5 w 60 ${py(v)} m 772 ${py(v)} l S\n`+text(Math.round(v),32,py(v)-3,9,false,muted);
      for(const previous of [true,false]){if(previous&&!r.comparison)continue;chart+=(previous?'0.82 0.60 0.22 RG [5 4] 0 d':'0 0.45 0.35 RG [] 0 d')+' 2 w\n';
        chart+=series.map((d,i)=>`${x(i)} ${py(previous?d.previous||0:d.current)} ${i?'l':'m'}`).join('\n')+' S\n';
        if(series.length===1)chart+=rect(x(0)-2,py(previous?series[0].previous||0:series[0].current)-2,4,4,previous?'0.82 0.60 0.22':green);}
      const step=Math.max(1,Math.ceil(series.length/8));series.forEach((d,i)=>{if(i%step===0||i===series.length-1)chart+=text(d.from.slice(8)+'/'+d.from.slice(5,7),x(i)-12,140,8,false,muted);});
      chart+='[] 0 d\n'+text('Verde: atual. Dourado tracejado: anterior. Os valores completos estão nas próximas páginas.',30,100,9,false,muted);pages.push(chart);}
    const cityRows=r.cities.map(c=>[c.name,c.conversations,c.orders,c.deliveries,c.shortages,this.rdemPercent(c.conversion)]);
    const tables=f.view==='measures'?[{title:'Medidas procuradas / '+r.city_name,headers:['Medida','Consultas','Estoque físico atual'],rows:r.measures.map(m=>[m.measure,m.consultations,this.rdemStock(m.stock)])},
      {title:'Municípios da medida selecionada / toda a rede',headers:['Município','Consultas'],rows:r.measure_cities.map(c=>[c.name,c.consultations])}]:
      [{title:'Municípios / busca: '+(f.citySearch||'todos'),headers:['Município','Conversas','Com pedido','Com entrega','Com falta','Conversão'],rows:cityRows}];
    if(f.view==='evolution')tables.push({title:'Comparação por município / '+this.rdemMetricName(f.metric),headers:['Município','Atual','Anterior'],rows:r.cities.map(c=>[c.name,c[f.metric],c.previous?.[f.metric]??'—'])});
    if(f.view!=='cities')tables.push({title:'Série / '+r.city_name,headers:['Período','Atual','Período anterior','Anterior'],rows:series.map(d=>[this.rpDate(d.from)+' a '+this.rpDate(d.to),d.current,d.previous_from?this.rpDate(d.previous_from)+' a '+this.rpDate(d.previous_to):'—',d.previous??'—'])});
    if(tables.reduce((n,t)=>n+t.rows.length,0)>1500)throw Error('O PDF comporta até 1.500 linhas. Reduza os filtros ou use CSV.');
    for(const table of tables)for(let start=0;start<Math.max(1,table.rows.length);start+=12){let out=header(pages.length+1)+text(fit(table.title,110),30,440,12,true)+rect(30,407,782,23,'0.94 0.96 0.96');
      const xs=table.headers.length===6?[38,309,406,508,610,710]:table.headers.length===4?[38,300,400,700]:[38,400,610];
      table.headers.forEach((h,i)=>out+=text(h,xs[i],415,9,true,muted));table.rows.slice(start,start+12).forEach((row,i)=>{const top=389-i*27;
        row.forEach((v,j)=>out+=text(fit(v,j===0?table.headers.length===6?40:48:35),xs[j],top,9,j===0));out+=rule(top-10);});
      if(!table.rows.length)out+=text('Nenhum registro neste recorte.',38,380,10,false,muted);pages.push(out);}
    return build(pages);
  },
};};
