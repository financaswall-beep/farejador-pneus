window.PAINEL_MODULES=window.PAINEL_MODULES||{};
window.PAINEL_MODULES.relatoriosFaltasPdf=function(){return{
  rfalPdfBytes(r,tab='overview'){
    const {text,rect,rule,fit,wrap,build,green,muted}=window.REPORT_PDF,f=r.filters,rows=tab==='potential'?r.opportunities:tab==='consultations'?r.consultations:r.measures;
    if(rows.length>1000)throw Error('O PDF comporta até 1.000 linhas. Reduza os filtros ou use CSV.');
    const header=page=>rect(0,509,842,86,green)+text('FAREJADOR / MATRIZ',30,566,12,true,'1 1 1')+text('Faltas por loja',30,536,22,true,'1 1 1')
      +text(fit((r.store?.name||'Sem loja no recorte')+' / '+this.rpDate(f.from)+' a '+this.rpDate(f.to),120),30,488,10,true)
      +text(fit((['overview','measures'].includes(tab)?'Medida selecionada no detalhe: ':'Filtro de medida: ')+(f.measure||'Todas')+' / Busca: '+(f.search||'Todas'),125),30,469,9,false,muted)
      +text('Preços e estoque consultados em '+this.rfalTime(r.as_of),30,450,9,false,muted)
      +rule(33)+text('Potencial estimado; não é lucro ou perda confirmada. Uma unidade por conversa e medida na loja.',30,20,8,false,muted)+text('Página '+page,765,20,8,false,muted);
    const scopes=['overview','measures'].includes(tab)?r.measures.map(m=>m.potential):r.opportunities.map(o=>({amount:o.reference?.amount??null,opportunities:1,priced:o.reference?1:0,unpriced:o.reference?0:1,repeated:o.searches-1}));
    const p=scopes.reduce((sum,item)=>({amount:sum.amount==null&&item.amount==null?null:((Math.round((sum.amount||0)*100)+Math.round((item.amount||0)*100))/100),
      opportunities:sum.opportunities+item.opportunities,priced:sum.priced+item.priced,unpriced:sum.unpriced+item.unpriced,repeated:sum.repeated+item.repeated}),{amount:null,opportunities:0,priced:0,unpriced:0,repeated:0});
    let cover=header(1);const kpis=[['Conversas com falta (rede)',r.summary.consultations],['Faltas registradas (rede)',r.summary.shortages],['Faltas na loja (total)',r.store?.shortages||0],['Potencial do recorte',this.rfalMoney(p.amount)]];
    kpis.forEach(([label,value],i)=>{const x=30+i*198;cover+=rect(x,350,188,77,'0.94 0.98 0.96')+text(label,x+10,403,9,false,muted)+text(value,x+10,370,i===3?17:23,true,green);});
    const notes=[p?p.priced+' de '+p.opportunities+' conversas por medida com preço. '+p.unpriced+' sem referência. '+p.repeated+' repetições removidas.':'Sem consultas por loja neste recorte.',
      'Estimativa: uma unidade por conversa e medida nesta loja, multiplicada pelo menor preço atual elegível.',
      'Filtros de marca, condição e posição registrados na busca são respeitados. Preços da Matriz e da Rede são separados.',
      'Uma falta por conversa, medida e loja no período. Medidas diferentes contam separadamente; reconsultas não aumentam o total.',
      'Não confirma intenção de compra nem venda posterior. Não somar valores de lojas: a mesma procura pode aparecer em várias.',
      'Estoque atual soma marcas e condições da medida e desconta reservas. Não substitui a disponibilidade histórica.',
      'Trilha por loja desde '+this.rfalTime(r.tracking_since)+'. Registros antigos sem trilha no período: '+r.legacy_records+'.',
      'A exportação respeita os filtros. A aba Consultas mantém todas as buscas, inclusive repetições; suas linhas não são o total de faltas.'];
    let y=325;for(const note of notes){for(const line of wrap(note,125)){cover+=text(line,30,y,9,false,muted);y-=13;}y-=10;}
    const pages=[cover];
    for(let start=0;start<Math.max(1,rows.length);start+=8){let out=header(pages.length+1)+rect(30,414,782,23,'0.94 0.96 0.96');
      const headers=tab==='consultations'?[['Data / medida',38],['Município / filtros',191],['Lojas e resultado',413]]:
        tab==='potential'?[['Data / medida',38],['Município',191],['Buscas agrupadas',380],['Preço por 1 unidade',504],['Referência',644]]:
        [['Medida',38],['Faltas',185],['Disponível hoje',250],['Conversas / repetições',368],['Sem preço',540],['Potencial estimado',645]];
      headers.forEach(([label,x])=>out+=text(label,x,422,9,true,muted));
      rows.slice(start,start+8).forEach((row,i)=>{const top=393-i*42;
        if(tab==='consultations'){
          out+=text(this.rfalTime(row.occurred_at),38,top,8)+text(row.measure+(row.searches>1?' / '+row.searches+' buscas':''),38,top-12,9,true)+text(fit(row.municipality||'Sem município',32),191,top,8)
            +text(fit(this.rfalScope(row),38),191,top-12,7,false,muted)+text(this.rfalOutcome(row),413,top,8);
          // The complete store trace is in CSV; the PDF states when it needs abbreviation.
          out+=text(fit(row.stores.map(s=>s.name+': '+(s.available?'tinha':'não tinha')).join(' / '),74),413,top-12,7,false,muted);
        }else if(tab==='potential')out+=text(this.rfalTime(row.occurred_at),38,top,8)+text(row.measure,38,top-12,9,true)
          +text(fit(row.municipality||'Sem município',31),191,top,8)+text(row.searches,380,top,9)+text(this.rfalMoney(row.reference?.amount),504,top,10,true,green)
          +text(fit(row.reference?.brand||'Sem referência',28),644,top,8)+text(row.reference?this.rpCondition(row.reference.condition):'',644,top-12,8,false,muted);
        else out+=text(row.measure,38,top,10,true)+text(row.shortages,185,top,9)+text(this.rfalStock(row.stock),250,top,9)
          +text(row.potential.opportunities+' / '+row.potential.repeated,368,top,9)+text(row.potential.unpriced,540,top,9)+text(this.rfalMoney(row.potential.amount),645,top,10,true,green);
        out+=rule(top-24);
      });if(!rows.length)out+=text('Nenhum registro encontrado neste recorte.',38,393,10,false,muted);
      out+=text(tab==='consultations'?'Nomes longos podem estar abreviados. O CSV contém os filtros e todas as lojas consultadas.':rows.length+' registros no recorte. Valores sem preço ficam fora da estimativa.',30,49,8,false,muted);pages.push(out);
    }return build(pages);
  },
};};
