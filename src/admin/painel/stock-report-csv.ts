import type { buildStockReport } from './queries-stock-report.js';
import { salesReportCsvCell } from './route-sales-report.js';
import { stockStatusLabels } from './stock-report-rules.js';
const condition=(value:string)=>({novo:'Novo',meia_vida:'Meia-vida',remold:'Remold'})[value]??value;
export function stockReportCsv(report:ReturnType<typeof buildStockReport>):string{
  const f=report.filters;let columns:string[],rows:unknown[][];
  if(f.view==='movements'){
    columns=['Movimento ID','Data e hora (São Paulo)','Medida','Marca','Condição','Origem','Saldo físico antes','Variação física','Saldo físico depois'];
    rows=report.export_movements.map(row=>[row.id,new Date(row.at).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}),
      row.measure,row.brand,condition(row.condition),row.label,row.before,row.delta,row.after]);
  }else{
    columns=['Medida','Condição','Físico agora','Reservado agora','Disponível agora','A caminho','Saídas líquidas de vendas',
      'Base do giro (dias)','Cobertura estimada (dias)','Mínimo','Reposição sugerida','Situação','Posição do estoque (UTC)'];
    rows=report.groups.filter(row=>f.view!=='replenishment'||(row.suggested??0)>0).map(row=>[row.measure,condition(row.condition),
      row.physical,row.reserved,row.available,row.incoming,row.sold,f.days,row.coverage_days===null?'Sem giro':String(row.coverage_days).replace('.',','),
      row.minimum===null?'Não definido':row.minimum,row.suggested===null?'Sem mínimo':row.suggested,stockStatusLabels[row.status],report.as_of]);
  }
  return '\uFEFF'+[columns,...rows].map(row=>row.map(salesReportCsvCell).join(';')).join('\r\n');
}
