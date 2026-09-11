import type { buildLogisticsReport } from './queries-logistics-report.js';
import { salesReportCsvCell } from './route-sales-report.js';
const status:Record<string,string>={delivered:'Entregue',failed:'Não entregue',cancelled:'Cancelado',pending:'Pendente',open:'Aberta',closed:'Encerrada',linked:'Vinculada',legacy:'Legado',rejected:'Rejeitado'};
const date=(v:string|null)=>v?new Date(v).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}):'';
export function logisticsReportCsv(report:ReturnType<typeof buildLogisticsReport>):string{
  const view=report.filters.view;let columns:string[],rows:unknown[][];
  if(view==='deliveries'){
    columns=['Rota','Entregador','Pedido ID','Pedido','Cliente','Situação','Data prevista','Saída (São Paulo)','Conclusão (São Paulo)','Motivo','Ocorrência histórica'];
    rows=report.deliveries.map(row=>[row.trip_number,row.courier,row.order_id,row.number,row.customer,status[row.result],row.scheduled,
      date(row.dispatched_at),date(row.delivered_at),row.reason,row.historical?'Sim':'Não']);
  }else if(view==='costs'){
    columns=['Rota','Entregador','Categoria','Valor vinculado','Situação','Data (São Paulo)','Comprovantes IDs','Despesa removida','Conciliação parcial'];
    rows=report.costs.map(row=>[row.trip_number,row.courier,row.category,row.amount===null?'':row.amount.toFixed(2).replace('.',','),
      status[row.state],date(row.occurred_at),row.receipt_ids.join(', '),row.missing_expense?'Sim':'Não',row.partial?'Sim':'Não']);
  }else{
    columns=['Rota ID','Rota','Entregador','Situação','Data base','Saída (São Paulo)','Retorno (São Paulo)','Entregas','Concluídas','Ocorrências','Km registrados','Duração (min)',
      'Fretes conhecidos','Despesas vinculadas','Saldo dos fretes','Resultado parcial','Situação financeira'];
    rows=report.trips.map(row=>[row.id,row.number,row.courier,status[row.status],row.day,date(row.started_at),date(row.ended_at),row.deliveries,row.delivered,row.occurrences,
      row.km===null?'Não informado':String(row.km).replace('.',','),row.duration_minutes??'',row.freight.toFixed(2).replace('.',','),row.expenses.toFixed(2).replace('.',','),
      row.freight_balance.toFixed(2).replace('.',','),row.partial?'Sim':'Não',row.financial_status]);
  }
  return '\uFEFF'+[columns,...rows].map(row=>row.map(salesReportCsvCell).join(';')).join('\r\n');
}
