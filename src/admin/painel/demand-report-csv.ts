import type { buildDemandReport } from './queries-demand-report.js';
import { shortageReportCell } from './shortage-report-csv.js';
export function demandReportCsv(r:ReturnType<typeof buildDemandReport>){
  const rows:unknown[][]=[['Demanda por município',r.filters.view],['Período',r.filters.from,r.filters.to],['Comparação',r.comparison?.from,r.comparison?.to],
    ['Município do detalhe',r.city_name],['Busca na lista de municípios',r.filters.citySearch],['Busca de medida',r.filters.search],['Medida do detalhe',r.selected_measure?.measure||'Nenhuma'],
    ['Posição atual',r.as_of],['Metodologia','Conversas distintas com atividade registrada no período. Cada indicador é contado uma vez por conversa, no primeiro dia em que ocorreu no intervalo. Pedidos e entregas usam suas próprias datas; cancelados excluídos.'],
    ['Localização','Último município conhecido da conversa, inclusive para períodos anteriores. Sem município fica separado; não representa clientes únicos.'],
    ['Estoque','Posição física atual da Matriz, somada entre marcas e condições. Inclui reservas; não indica estoque histórico nem promessa de entrega.'],[]];
  if(r.filters.view==='measures'){
    rows.push(['Medida','Consultas por medida','Estoque físico atual da Matriz']);for(const m of r.measures)rows.push([m.measure,m.consultations,m.stock??'Não informado']);
    rows.push([],['Outros municípios da medida selecionada (toda a rede)','Consultas']);for(const c of r.measure_cities)rows.push([c.name,c.consultations]);
  }else if(r.filters.view!=='evolution'){
    rows.push(['Município','Conversas','Com pedido','Com entrega','Com falta','Conversão (%)']);for(const c of r.cities)rows.push([c.name,c.conversations,c.orders,c.deliveries,c.shortages,c.conversion?.toFixed(1).replace('.',',')??'Sem base']);
  }
  if(r.filters.view!=='cities'){
    rows.push([],['Evolução',r.filters.view==='measures'?'Consultas de '+(r.selected_measure?.measure||'nenhuma medida'):r.filters.metric,r.city_name],
      ['Início','Fim','Atual','Início anterior','Fim anterior','Anterior']);
    for(const d of r.filters.view==='measures'?r.measure_series:r.series)rows.push([d.from,d.to,d.current,d.previous_from,d.previous_to,d.previous]);
  }
  if(r.filters.view==='evolution'){
    rows.push([],['Comparação de municípios (busca da lista aplicada)',r.filters.metric],['Município','Atual','Anterior']);
    for(const c of r.cities)rows.push([c.name,c[r.filters.metric],c.previous?.[r.filters.metric]]);
  }
  return '\uFEFF'+rows.map(row=>row.map(shortageReportCell).join(';')).join('\r\n');
}
