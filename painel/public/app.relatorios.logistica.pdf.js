window.PAINEL_MODULES=window.PAINEL_MODULES||{};
window.PAINEL_MODULES.relatoriosLogisticaPdf=function(){return {
  rlogPdfBytes(report,tab='overview'){
    const {text,rect,rule,fit,wrap,build,green,muted}=window.REPORT_PDF;
    const deliveries=tab==='deliveries',costs=tab==='costs',rows=deliveries?report.deliveries:costs?report.costs:report.trips;
    if(rows.length>1000)throw Error('O PDF comporta até 1.000 linhas. Reduza os filtros ou use CSV.');
    const f=report.filters,s=report.summary,title=deliveries?'Entregas das rotas':costs?'Custos e comprovantes':'Rotas do período';
    const header=(title,page)=>{
      let out=rect(0,509,842,86,green)+text('FAREJADOR / MATRIZ',30,566,12,true,'1 1 1')+text(title,30,537,21,true,'1 1 1');
      const courier=report.couriers.find(row=>row.id===f.courier)?.name||'Todos os entregadores';
      const filters=[this.rpDate(f.from)+' a '+this.rpDate(f.to),courier,f.status==='all'?'Todas as situações':this.rlogStatus(f.status),f.search,
        (deliveries||costs)&&f.trip?'Rota '+(report.trips.find(r=>r.id===f.trip)?.number||f.trip):'',
        deliveries&&f.delivery!=='all'?this.rlogStatus(f.delivery):'',costs&&f.receipt!=='all'?this.rlogStatus(f.receipt):''].filter(Boolean).join(' / ');
      wrap(filters,118).slice(0,3).forEach((line,i)=>out+=text(line,30,491-i*10,8,false,muted));
      return out+text('Consultado em '+this.rlogTime(report.as_of),30,447,8,false,muted)+rule(33)
        +text('Rotas pela data de encerramento; abertas pela saída. Despesas vinculadas, sem somar gasolina anotada.',30,20,7,false,muted)+text('Página '+page,761,20,8,false,muted);
    };
    let cover=header('Entregas e rotas',1);
    [['Entregas concluídas',this.rpNumber(s.delivered)],['Rotas encerradas',this.rpNumber(s.closed)],['Km registrados',s.km==null?'Não informado':this.rlogKm(s.km)],['Despesa por entrega',s.cost_per_delivery==null?'Sem base':this.rpMoney(s.cost_per_delivery)]].forEach(([label,value],i)=>{
      const x=30+i*198;cover+=rect(x,346,188,76,'0.94 0.98 0.96')+text(label,x+10,399,9,false,muted)+text(value,x+10,368,20,true,green);
    });
    cover+=text(s.partial?'Valores parciais: existem rotas com conciliação ou dados pendentes.':'Despesas vinculadas das rotas encerradas / entregas concluídas nessas rotas.',30,325,9,false,muted)
      +text(s.km_missing+' rotas encerradas sem km informado. '+s.pending_receipts+' comprovantes pendentes.',30,307,9,false,muted)+text('ROTAS DO PERÍODO',30,276,12,true);
    report.trips.slice(0,5).forEach((r,i)=>{const y=247-i*31;cover+=text(fit(r.number+' / '+r.courier,32),30,y,10,true)
      +text(r.delivered+' de '+r.deliveries+' entregues',270,y,9,false,muted)+text(this.rlogKm(r.km),420,y,9,false,muted)
      +text(this.rpMoney(r.expenses),565,y,10,true,green)+text(r.partial?'Parcial':this.rlogStatus(r.status),713,y,8,false,muted)+rule(y-14);});
    cover+=text('Saldo dos fretes = fretes conhecidos das entregas concluídas - despesas vinculadas à rota.',30,64,9,false,muted)
      +text('Ocorrências históricas permanecem na rota original, mesmo após uma reentrega.',30,49,9,false,muted);
    const pages=[cover];
    const headings=deliveries?[['Pedido / cliente',38],['Rota / entregador',264],['Situação',456],['Prevista / conclusão',568],['Motivo',710]]:
      costs?[['Rota / categoria',38],['Data',262],['Valor',400],['Situação',506],['Comprovantes',706]]:
      [['Rota / entregador',38],['Entregas',247],['Km',318],['Fretes',402],['Despesas',492],['Saldo fretes',584],['Situação',710]];
    for(let start=0;start<Math.max(1,rows.length);start+=10){let out=header(title,pages.length+1)+rect(30,414,782,23,'0.94 0.96 0.96');headings.forEach(([label,x])=>out+=text(label,x,422,8,true,muted));
      rows.slice(start,start+10).forEach((r,index)=>{const y=394-index*33;
        const cells=deliveries?[[r.number||r.order_id.slice(0,8),38],[r.trip_number,264],[this.rlogStatus(r.result),456],[r.scheduled?this.rpDate(r.scheduled):'—',568],[fit(r.reason||'—',19),710]]:
          costs?[[r.trip_number+' / '+this.rlogCategory(r.category),38],[this.rlogTime(r.occurred_at),262],[r.amount==null?'Sem lançamento':this.rpMoney(r.amount),400],[this.rlogCostState(r),506],[r.receipt_ids.length,706]]:
          [[r.number,38],[r.delivered+' / '+r.deliveries,247],[r.km==null?'—':r.km,318],[this.rpMoney(r.freight),402],[this.rpMoney(r.expenses),492],[this.rpMoney(r.freight_balance),584],[r.partial?'Parcial':this.rlogStatus(r.status),710]];
        cells.forEach(([value,x])=>out+=text(fit(value,x===38?35:28),x,y,8,x===38));
        out+=text(fit(deliveries?r.customer||'Cliente não informado':costs?r.courier:r.courier+' / '+this.rpDate(r.day),45),38,y-11,7,false,muted);
        if(deliveries)out+=text(fit(r.courier,34),264,y-11,7,false,muted)+text(r.historical?'Ocorrência histórica':this.rlogTime(r.delivered_at),568,y-11,7,false,muted);
        if(!deliveries&&!costs)out+=text(r.occurrences+' ocorrências',710,y-11,7,false,muted);out+=rule(y-19);
      });if(!rows.length)out+=text('Nenhum registro neste recorte.',38,389,10,false,muted);
      out+=text((rows.length?start+1:0)+' a '+Math.min(start+10,rows.length)+' de '+rows.length+' registros.',30,49,8,false,muted);pages.push(out);
    }return build(pages);
  },
};};
