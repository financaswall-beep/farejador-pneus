// PDF vetorial A4, sem serviço externo. Mesmo snapshot e filtros do relatório.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.relatoriosPdf = function () {
  const clean=value=>String(value??'').replace(/[–—]/g,'-').replace(/[“”]/g,'"').replace(/[‘’]/g,"'").replace(/[·•]/g,' / ').replace(/[^\x20-\xFF]/g,' ');
  const escaped=value=>clean(value).replaceAll('\\','\\\\').replaceAll('(','\\(').replaceAll(')','\\)');
  const fit=(value,n)=>clean(value).length>n?clean(value).slice(0,n-3)+'...':clean(value);
  const text=(value,x,y,size=9,bold=false,color='0.08 0.14 0.20')=>`${color} rg BT /F${bold?2:1} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${escaped(value)}) Tj ET\n`;
  const rect=(x,y,w,h,color)=>`${color} rg ${x} ${y} ${w} ${h} re f\n`;
  const rule=(y)=>`0.86 0.90 0.91 RG 0.5 w 30 ${y} m 812 ${y} l S\n`;
  const green='0.00 0.33 0.27',muted='0.36 0.43 0.49';
  const wrap=(value,n=100)=>{const words=clean(value).split(' ').flatMap(word=>word.match(new RegExp('.{1,'+n+'}','g'))||[]),rows=[''];for(const word of words){if(rows.at(-1).length+word.length+1>n)rows.push('');rows[rows.length-1]+=(rows.at(-1)?' ':'')+word;}return rows;};
  function build(contents) {
    const objects=[null,'<< /Type /Catalog /Pages 2 0 R >>','',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'];
    const pages=[];
    for(const content of contents){const page=objects.length;pages.push(page);objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${page+1} 0 R >>`);objects.push(`<< /Length ${content.length} >>\nstream\n${content}endstream`);}
    objects[2]=`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map(id=>id+' 0 R').join(' ')}] >>`;
    let pdf='%PDF-1.4\n',offsets=[0];
    for(let id=1;id<objects.length;id++){offsets[id]=pdf.length;pdf+=`${id} 0 obj\n${objects[id]}\nendobj\n`;}
    const xref=pdf.length;pdf+=`xref\n0 ${objects.length}\n0000000000 65535 f \n`;
    for(let id=1;id<objects.length;id++)pdf+=`${String(offsets[id]).padStart(10,'0')} 00000 n \n`;
    pdf+=`trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return Uint8Array.from(pdf,c=>c.charCodeAt(0)&255);
  }
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
