import type { buildShortageReport } from './queries-shortage-report.js';
export const shortageReportCell=(value:unknown)=>{
  let text=String(value??'');if(/^[\s]*[=+@-]/.test(text)||/^[\t\r\n]/.test(text))text="'"+text;
  return '"'+text.replace(/"/g,'""')+'"';
};
export function shortageReportCsv(r:ReturnType<typeof buildShortageReport>){
  const money=(v:number|null)=>v===null?'Sem referência':v.toFixed(2).replace('.',',');
  const rows:unknown[][]=[['Faltas por loja',r.store?.name||'Sem loja no recorte'],['Período',r.filters.from,r.filters.to],
    ['Posição do estoque e dos preços',r.as_of],[['overview','measures'].includes(r.filters.view)?'Medida selecionada no detalhe (lista completa abaixo)':'Medida filtrada',r.filters.measure||'Todas'],['Busca de medida',r.filters.search],
    ['Metodologia','Receita potencial estimada, não lucro nem perda confirmada. Uma unidade por conversa e medida na loja; menor preço atual elegível da Matriz ou da Rede.'],
    ['Limites','Não confirma intenção de compra ou venda posterior. Não somar potenciais entre lojas; a mesma conversa pode aparecer em várias. Estoque atual soma marcas e condições, já descontadas as reservas.'],
    ['Registro por loja desde',r.tracking_since||'Ainda sem registros'],['Registros antigos sem trilha por loja',r.legacy_records],[]];
  if(r.filters.view==='consultations'){
    rows.push(['Data e hora','Medida','Município','Filtros da busca','Lojas consultadas','Resultado','Referência atual (não somar as consultas)']);
    for(const t of r.consultations)rows.push([t.occurred_at,t.measure,t.municipality,Object.entries(t.filters).map(([k,v])=>k+': '+v).join(' · '),
      t.stores.map(s=>s.name+': '+(s.available?'tinha':'não tinha')).join(' | '),t.available_elsewhere?'Havia em outra loja consultada':'Sem disponibilidade nas lojas consultadas',money(t.reference?.amount??null)]);
  }else if(r.filters.view==='potential'){
    rows.push(['Última busca do grupo','Medida','Município da última busca','Buscas agrupadas','Unidade estimada','Preço atual de referência','Marca da referência','Condição']);
    for(const o of r.opportunities)rows.push([o.occurred_at,o.measure,o.municipality,o.searches,1,money(o.reference?.amount??null),o.reference?.brand,o.reference?.condition]);
  }else{
    rows.push(['Medida','Faltas registradas','Disponível agora','Conversas por medida','Repetições removidas','Com preço','Sem preço','Receita potencial estimada']);
    for(const m of r.measures)rows.push([m.measure,m.shortages,m.stock??'Não informado',m.potential.opportunities,m.potential.repeated,m.potential.priced,m.potential.unpriced,money(m.potential.amount)]);
  }
  return '\uFEFF'+rows.map(row=>row.map(shortageReportCell).join(';')).join('\r\n');
}
