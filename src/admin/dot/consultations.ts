import { z } from 'zod';
import { env } from '../../shared/config/env.js';
import { businessDateSaoPaulo } from '../../shared/business-time.js';
import { reportAddDays } from '../painel/report-period.js';
import { overviewPeriod } from '../painel/matriz-overview.js';
import { readOverviewSales } from '../painel/matriz-overview-sales.js';
import { readOverviewAttention } from '../painel/matriz-overview-operations.js';
import { getStockReport } from '../painel/queries-stock-report.js';
import { stockReportQuery } from '../painel/stock-report-filter.js';
import { withDotReadOnly } from './read-only.js';
import { readDotFinance } from './finance-read.js';
import { readDotDeliveries } from './deliveries-read.js';

export const periodInput = z.object({periodo:z.enum(['hoje','7dias','30dias','mes']).default('hoje'),
  mes:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional()}).strict();
export const stockInput = z.object({medida:z.string().trim().max(30).regex(/^[\d\s/.RrXx-]*$/).default(''),
  situacao:z.enum(['todos','zerado','repor']).default('todos'),
  tipo_veiculo:z.enum(['all','motorcycle','car']).default('all')}).strict();
export const deliveryInput = z.object({situacao:z.enum(['todas_abertas','pendentes','em_entrega','problemas']).default('todas_abertas')}).strict();
export const financeInput = z.object({mes:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional()}).strict();

export const dotSchemas = {consultar_resumo_matriz:periodInput,consultar_vendas_matriz:periodInput,
  consultar_estoque_matriz:stockInput,consultar_entregas_matriz:deliveryInput,consultar_financeiro_matriz:financeInput};
export type DotToolName = keyof typeof dotSchemas;

export function dotPeriod(input:z.infer<typeof periodInput>,now=new Date()) {
  const today=businessDateSaoPaulo(now),month=input.mes??today.slice(0,7);
  if(input.mes && input.periodo!=='mes')throw new Error('month_requires_month_period');
  if(input.periodo==='30dias')return {from:reportAddDays(today,-29),to:today,month:today.slice(0,7)};
  return overviewPeriod(input.periodo==='hoje'?'today':input.periodo==='7dias'?'7d':'month',month,now);
}
export async function runDotConsultation(name:DotToolName,raw:unknown):Promise<Record<string,unknown>> {
  const metadata={environment:env.FAREJADOR_ENV,timezone:'America/Sao_Paulo',currency:'BRL',
    read_at:new Date().toISOString(),scope:'matriz',read_only:true};
  if(name==='consultar_estoque_matriz') {
    const input=stockInput.parse(raw),filter=stockReportQuery.parse({measure:input.medida,
      status:input.situacao==='zerado'?'zero':input.situacao==='repor'?'replenish':'all',vehicle_type:input.tipo_veiculo});
    // The existing report already opens its own REPEATABLE READ READ ONLY snapshot.
    const report=await getStockReport(filter,env.FAREJADOR_ENV);
    return {...metadata,as_of:report.as_of,summary:report.summary,total:report.groups.length,truncated:report.groups.length>50,
      products:report.groups.slice(0,50).map(row=>({measure:row.measure,condition:row.condition,vehicle_type:row.vehicle_type,
        physical:row.physical,reserved:row.reserved,available:row.available,incoming:row.incoming,minimum:row.minimum,
        suggested:row.suggested,status:row.status,sold_30d:row.sold,coverage_days:row.coverage_days})),
      warning:'Estoque da Matriz. Mínimo não definido é desconhecido, não significa estoque suficiente.'};
  }
  const data=await withDotReadOnly(async db=>{
    if(name==='consultar_entregas_matriz')return readDotDeliveries(db,deliveryInput.parse(raw).situacao);
    if(name==='consultar_financeiro_matriz') {
      const input=financeInput.parse(raw),month=dotPeriod({periodo:'mes',mes:input.mes}).month;
      return readDotFinance(db,month);
    }
    const period=dotPeriod(periodInput.parse(raw));
    const sales=await readOverviewSales(db,env.FAREJADOR_ENV,period.from,period.to);
    return {period,sales,...(name==='consultar_resumo_matriz'?{attention:await readOverviewAttention(db,env.FAREJADOR_ENV)}:{}),
      monetary_unit:'centavos',warning:'Receita comercial das vendas realizadas; não equivale a dinheiro recebido nem a lucro.'};
  });
  return {...metadata,...data};
}
