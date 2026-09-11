window.PAINEL_MODULES=window.PAINEL_MODULES||{};
window.PAINEL_MODULES.relatoriosFinanceiroPdf=function(){return{
  rfinPdfBytes(report,tab='overview'){
    const {text,rect,rule,fit,wrap,build,green,muted}=window.REPORT_PDF,f=report.filters,s=report.summary;
    const projected=tab==='cash'&&f.flow==='projected',titles=tab==='titles'||projected,cash=tab==='cash'&&!projected;
    const rows=titles?(projected?report.projection.rows:report.titles):cash?report.cash_rows:tab==='result'?report.result_rows:report.daily;
    if(rows.length>1000)throw Error('O PDF comporta até 1.000 linhas. Reduza os filtros ou use CSV.');
    const label=titles?(projected?'Previsão do caixa':'Títulos em aberto'):cash?'Fluxo de caixa realizado':tab==='result'?'Resultado por competência':'Visão geral financeira';
    const header=(title,page)=>{
      let out=rect(0,509,842,86,green)+text('FAREJADOR / MATRIZ',30,566,12,true,'1 1 1')+text(title,30,537,21,true,'1 1 1');
      const filters=[titles?'Posição atual: '+this.rpDate(report.today):this.rpDate(f.from)+' a '+this.rpDate(f.to),f.origin==='all'?'Todas as origens':this.rfinOrigin(f.origin),
        projected?'Previsão de '+this.rpDate(report.projection.from)+' a '+this.rpDate(report.projection.to):'',f.search,
        cash&&f.cash_day?'Dia '+this.rpDate(f.cash_day):'',(cash||projected)&&f.direction!=='all'?(f.direction==='in'?'Entradas':'Saídas'):'',
        tab==='titles'?({all:'A receber e a pagar',receivable:'A receber',payable:'A pagar'})[f.title_side]+' / '+({all:'Todos os vencimentos',overdue:'Vencidos',today:'Vencem hoje',next7:'Próximos 7 dias',next30:'Próximos 30 dias',undated:'Sem vencimento'})[f.due]:'',
        tab==='result'?'Componente: '+({all:'Todos',revenue:'Receitas',cost:'Custo dos pneus',expense:'Despesas e perdas',adjustment:'Ajustes de estoque'})[f.result_kind]:''].filter(Boolean).join(' / ');
      wrap(filters,115).slice(0,3).forEach((line,i)=>out+=text(line,30,491-i*10,8,false,muted));
      return out+text('Consultado em '+this.rfinTime(report.as_of),30,447,8,false,muted)+rule(33)
        +text('Resultado por competência; caixa por pagamento; títulos na posição atual. Saldos registrados no sistema.',30,20,7,false,muted)+text('Página '+page,765,20,8,false,muted);
    };
    let cover=header(label,1);
    const kpis=titles?[[projected?'A receber no horizonte':'A receber em aberto',projected?report.projection.incoming:report.position.receivable],
      [projected?'A pagar no horizonte':'A pagar em aberto',projected?report.projection.outgoing:report.position.payable],['Vencido a receber',report.position.overdue_receivable],['Vencido a pagar',report.position.overdue_payable]]:
      cash?[['Saldo anterior',s.opening],['Entradas',s.incoming],['Saídas',s.outgoing],['Saldo ao final',s.closing]]:
      [['Receitas',s.revenue],['Custo dos pneus',s.cost],['Despesas e perdas',s.expense+s.inventory_loss],['Resultado conhecido',s.result]];
    kpis.forEach(([name,value],i)=>{const x=30+i*198;cover+=rect(x,347,188,76,'0.94 0.98 0.96')+text(name,x+10,401,9,false,muted)+text(this.rpMoney(value),x+10,367,19,true,green);});
    const notes=[s.partial?'Resultado parcial: custos ou integração com pendências.':'Resultado calculado pelos lançamentos existentes.',
      s.pending_items?s.pending_items+' itens com custo pendente. '+this.rpMoney(s.pending_revenue)+' de receitas fora do resultado conhecido.':'Taxas e impostos entram quando registrados.',
      projected?'Previsão pelos vencimentos; atrasados e sem data ficam fora dos valores previstos.':titles?'Saldos já descontados das baixas. Compras podem estar parceladas; comissões podem estar agrupadas.':cash?'Saldo anterior + entradas - saídas = saldo ao final. Não representa conciliação bancária.':'Ganhos e perdas de estoque também compõem o resultado.',
      cash?'Os indicadores usam o período e a origem. Dia, direção e busca filtram o extrato.':'As páginas seguintes incluem todos os registros filtrados.'];
    notes.forEach((line,i)=>cover+=text(line,30,323-i*19,9,false,muted));
    cover+=text(titles?'AGENDA ATUAL':cash?'CONFERÊNCIA DO CAIXA':'PRINCIPAIS ORIGENS DO RESULTADO',30,211,12,true);
    if(titles){
      [['Próximos 7 dias',report.position.next7_receivable,report.position.next7_payable],['Sem vencimento informado',report.position.undated_receivable,report.position.undated_payable]].forEach(([name,receivable,payable],i)=>{
        const y=182-i*35;cover+=text(name,30,y,10,true)+text('A receber '+this.rpMoney(receivable),285,y,10,false,muted)+text('A pagar '+this.rpMoney(payable),565,y,10,false,muted)+rule(y-12);
      });
    }else if(cash){
      cover+=text('Saldo anterior '+this.rpMoney(s.opening)+' + entradas '+this.rpMoney(s.incoming)+' - saídas '+this.rpMoney(s.outgoing),30,181,11,false,muted)
        +text('Saldo ao final: '+this.rpMoney(s.closing),30,152,15,true,green)
        +text('Extrato filtrado: entradas '+this.rpMoney(report.cash_filtered.incoming)+' / saídas '+this.rpMoney(report.cash_filtered.outgoing),30,118,10,false,muted);
    }else [...report.origins].sort((a,b)=>Math.abs(b.result)-Math.abs(a.result)).slice(0,5).forEach((r,i)=>{const y=185-i*24;cover+=text(this.rfinOrigin(r.origin),30,y,10,true)+text('Receitas '+this.rpMoney(r.revenue),215,y,9,false,muted)
      +text('Resultado conhecido '+this.rpMoney(r.result),475,y,9,true,green)+rule(y-10);});
    const pages=[cover];
    const headings=titles?[['Nome / origem',38],['Direção',318],['Vencimento',424],['Saldo pendente',545],['Situação',670]]:
      cash?[['Data / descrição',38],['Origem / referência',336],['Entrada',545],['Saída',670]]:
      tab==='result'?[['Competência / descrição',38],['Origem',336],['Receitas',475],['Custos e despesas',578],['Efeito registrado',704]]:
      [['Dia',38],['Resultado do dia',210],['Resultado acumulado',392],['Entradas',578],['Saídas',704]];
    for(let start=0;start<Math.max(1,rows.length);start+=10){let out=header(label,pages.length+1)+rect(30,414,782,23,'0.94 0.96 0.96');headings.forEach(([name,x])=>out+=text(name,x,422,8,true,muted));
      rows.slice(start,start+10).forEach((r,i)=>{const y=394-i*33;
        const cells=titles?[[fit(r.name,46),38],[r.side==='receivable'?'A receber':'A pagar',318],[this.rpDate(r.due_on),424],[this.rpMoney(r.amount),545],[this.rfinPdfDue(r,report.today),670]]:
          cash?[[this.rpDate(r.cash_on),38],[this.rfinOrigin(r.origin),336],[this.rpMoney(r.cash_in),545],[this.rpMoney(r.cash_out),670]]:
          tab==='result'?[[this.rpDate(r.competence_on),38],[this.rfinOrigin(r.origin),336],[this.rpMoney(r.revenue),475],[this.rpMoney(r.cost+r.expense+r.loss),578],[this.rpMoney(r.result),704]]:
          [[this.rpDate(r.day),38],[this.rpMoney(r.result),210],[this.rpMoney(r.cumulative),392],[this.rpMoney(r.cash_in),578],[this.rpMoney(r.cash_out),704]];
        cells.forEach(([value,x])=>out+=text(fit(value,x===38?46:25),x,y,8,x===38));
        if(titles)out+=text(this.rfinOrigin(r.origin),38,y-11,7,false,muted);
        else if(cash||tab==='result'){out+=text(fit(r.description,54),38,y-11,7,false,muted)+text(fit(r.reference||r.source_id,28),336,y-11,7,false,muted);
          if(r.reversal_of)out+=text('Estorno',704,y-11,7,false,muted);}
        out+=rule(y-19);
      });if(!rows.length)out+=text('Nenhum registro encontrado neste recorte.',38,389,10,false,muted);
      out+=text((rows.length?start+1:0)+' a '+Math.min(start+10,rows.length)+' de '+rows.length+' registros.',30,49,8,false,muted);pages.push(out);
    }return build(pages);
  },
  rfinPdfDue(row,today){if(!row.due_on)return'Sem vencimento';return row.due_on<today?'Vencido':row.due_on===today?'Vence hoje':'A vencer';},
};};
