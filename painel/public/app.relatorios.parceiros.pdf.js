window.PAINEL_MODULES=window.PAINEL_MODULES||{};
window.PAINEL_MODULES.relatoriosParceirosPdf=function(){return{
  rparPdfBytes(report,tab='overview'){
    const {text,rect,rule,fit,wrap,build,green,muted}=window.REPORT_PDF,f=report.filters,s=report.summary;
    const sales=tab==='sales',commissions=tab==='commissions',rows=sales?report.sales:commissions?report.commissions:report.partners;
    if(rows.length>1000)throw Error('O PDF comporta até 1.000 linhas. Reduza os filtros ou use CSV.');
    const label=sales?'Vendas dos parceiros':commissions?'Comissões da Rede':'Desempenho dos parceiros';
    const header=page=>{let out=rect(0,509,842,86,green)+text('FAREJADOR / MATRIZ',30,566,12,true,'1 1 1')+text(label,30,537,21,true,'1 1 1');
      const filters=[this.rpDate(f.from)+' a '+this.rpDate(f.to),f.city||'Todos os municípios',f.search,f.status==='all'?'Todas as situações':this.rparStatus(f.status),
        f.activity==='all'?'Com e sem vendas':f.activity==='selling'?'Com vendas':'Sem vendas',f.partner?report.partners.find(p=>p.id===f.partner)?.name||'Parceiro filtrado':'',sales&&f.channel!=='all'?this.rparChannel(f.channel):'',commissions?this.rparScope(f.commission_scope):''].filter(Boolean).join(' / ');
      wrap(filters,117).slice(0,3).forEach((line,i)=>out+=text(line,30,491-i*11,8,false,muted));
      return out+text('Consultado em '+this.rparTime(report.as_of),30,447,8,false,muted)+rule(33)+text('Vendas realizadas; comissões pelo livro; saldos em aberto na posição atual.',30,20,8,false,muted)+text('Página '+page,765,20,8,false,muted);};
    let cover=header(1);const kpis=commissions?[['Geradas no período',s.generated],['Recebidas no período',s.received],['Estornadas no período',s.reversed],['A receber agora',s.open]]:
      [['Vendas dos parceiros',s.sales],['Pedidos concluídos',s.orders],['Parceiros com vendas',s.selling],['Comissões geradas',s.generated]];
    kpis.forEach(([name,value],i)=>{const x=30+i*198;cover+=rect(x,347,188,76,'0.94 0.98 0.96')+text(name,x+10,401,9,false,muted)
      +text(!commissions&&(i===1||i===2)?this.rpNumber(value):this.rparMoney(value),x+10,367,17,true,green);});
    const notes=[report.comparison?'Comparação: '+this.rpDate(report.comparison.from)+' a '+this.rpDate(report.comparison.to):'Sem comparação de período.',
      'Vendas incluem frete. Comissões usam a base e o percentual registrados, com frete fora da base.',
      'Diretas da loja incluem balcão, telefone e outras vendas próprias. Canceladas ficam fora das vendas.',
      'Geradas preserva a comissão original; estornos e recebimentos possuem datas próprias.',
      'A receber considera todos os períodos das lojas filtradas. Mensalidades não entram neste relatório.',
      report.commission_enabled?'Os registros exportados incluem todas as páginas da aba.':'Livro de comissões desativado: valores de comissão não estão disponíveis.',
      s.undated?s.undated+' vendas concluídas sem data ficam fora dos valores.':'',s.unlinked?s.unlinked+' vendas do Farejador sem comissão registrada; podem incluir contratos de mensalidade.':''];
    notes.filter(Boolean).forEach((line,i)=>cover+=text(line,30,321-i*21,9,false,muted));
    cover+=text('REGISTROS NO RECORTE: '+rows.length,30,109,12,true)+text('Município corresponde ao cadastro da loja. Parceiro agrupa suas lojas filtradas.',30,82,9,false,muted);
    const pages=[cover],headers=sales?[['Pedido / data',38],['Parceiro / loja',192],['Origem',429],['Itens',562],['Total',614],['Comissão',716]]:
      commissions?[['Parceiro / pedido',38],['Gerada em',281],['Base sem frete',380],['Taxa',493],['Valor',562],['Situação atual',686]]:
      [['Parceiro / município',38],['Vendas',285],['Pedidos',397],['Variação',462],['Geradas',545],['A receber agora',680]];
    for(let start=0;start<Math.max(1,rows.length);start+=10){let out=header(pages.length+1)+rect(30,414,782,23,'0.94 0.96 0.96');headers.forEach(([name,x])=>out+=text(name,x,422,8,true,muted));
      rows.slice(start,start+10).forEach((r,i)=>{const y=394-i*33,cells=sales?[[this.rparReference(r.id),38],[fit(r.partner_name,39),192],[this.rparChannel(r.channel),429],[r.quantity,562],[this.rpMoney(r.total),614],[this.rparMoney(r.commission),716]]:
        commissions?[[fit(r.partner_name,43),38],[this.rpDate(r.day),281],[this.rpMoney(r.base),380],[this.rparPercent(r.percent),493],[this.rpMoney(f.commission_scope==='refund'?r.refund_amount:r.amount),562],[this.rparStatus(r.status),686]]:
        [[fit(r.name,41),38],[this.rpMoney(r.sales),285],[r.orders,397],[r.delta===null?'Sem base':this.rparPercent(r.delta),462],[this.rparMoney(r.generated),545],[this.rparMoney(r.open),680]];
        cells.forEach(([value,x])=>out+=text(value,x,y,8,x===38));
        if(sales)out+=text(this.rpDate(r.day),38,y-11,7,false,muted)+text(fit(r.unit_name,39),192,y-11,7,false,muted);
        else if(commissions)out+=text(this.rparReference(r.order_id),38,y-11,7,false,muted)+text('Recebida '+this.rparDate(r.settled_on)+' / estornada '+this.rparDate(r.reversed_on),281,y-11,7,false,muted);
        else out+=text(fit(r.city,47),38,y-11,7,false,muted);out+=rule(y-19);
      });if(!rows.length)out+=text('Nenhum registro encontrado neste recorte.',38,389,10,false,muted);
      out+=text((rows.length?start+1:0)+' a '+Math.min(start+10,rows.length)+' de '+rows.length+' registros.',30,49,8,false,muted);pages.push(out);
    }return build(pages);
  },
};};
