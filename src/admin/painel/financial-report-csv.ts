import type { buildFinancialReport } from './queries-financial-report.js';
import { salesReportCsvCell } from './route-sales-report.js';
const value=(n:number)=>n.toFixed(2).replace('.',',');
const statusLabel:Record<string,string>={overdue:'Vencido',today:'Vence hoje',upcoming:'A vencer',undated:'Sem vencimento'};
export function financialReportCsv(report:ReturnType<typeof buildFinancialReport>){
  const f=report.filters;let columns:string[],rows:unknown[][];
  if(f.view==='titles'||f.view==='cash'&&f.flow==='projected'){
    columns=['Posição consultada em','Direção','Nome / descrição','Origem','Vencimento','Saldo pendente','Situação','Referência','Títulos agrupados'];
    rows=(f.view==='titles'?report.titles:report.projection.rows).map(r=>[report.today,r.side==='receivable'?'A receber':'A pagar',r.name,r.origin,r.due_on,value(r.amount),statusLabel[r.status],r.source_id,r.count]);
  }else if(f.view==='cash'){
    columns=['Data do pagamento','Descrição','Origem','Referência','Cliente / fornecedor','Entrada','Saída','Forma de pagamento','Conta informada','Estorno','Original estornado'];
    rows=report.cash_rows.map(r=>[r.cash_on,r.description,r.origin,r.reference||r.source_id,r.party,value(r.cash_in),value(r.cash_out),r.payment_method,r.cash_account,r.reversal_of?'Sim':'Não',r.reversed?'Sim':'Não']);
  }else if(f.view==='result'){
    columns=['Competência','Descrição','Origem','Referência','Receitas','Custo dos pneus','Despesas','Ganhos de estoque','Perdas / uso interno','Efeito registrado','Estorno'];
    rows=report.result_rows.map(r=>[r.competence_on,r.description,r.origin,r.reference||r.source_id,value(r.revenue),value(r.cost),value(r.expense),value(r.gain),value(r.loss),value(r.result),r.reversal_of?'Sim':'Não']);
  }else{
    columns=['Dia','Resultado conhecido do dia','Resultado conhecido acumulado','Entradas de caixa','Saídas de caixa','Resultado parcial'];
    rows=report.daily.map(r=>[r.day,value(r.result),value(r.cumulative),value(r.cash_in),value(r.cash_out),report.summary.partial?'Sim':'Não']);
  }
  return'\uFEFF'+[columns,...rows].map(row=>row.map(salesReportCsvCell).join(';')).join('\r\n');
}
