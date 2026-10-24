import { z } from 'zod';
import { env } from '../../shared/config/env.js';
import { readOverviewSales } from '../painel/matriz-overview-sales.js';
import { readOverviewAttention } from '../painel/matriz-overview-operations.js';
import { getStockReport } from '../painel/queries-stock-report.js';
import { stockReportQuery } from '../painel/stock-report-filter.js';
import { withDotReadOnly } from './read-only.js';
import { readDotFinanceDetails } from './finance-details.js';
import { readDotDeliveries } from './deliveries-read.js';
import { periodInput, dotPeriod } from './period.js';
import { expandedTools, type ExpandedToolName } from './expanded-tools.js';
import { reportInput, reportTarget } from './reports.js';
export { periodInput, dotPeriod } from './period.js';

export const stockInput = z.object({medida:z.string().trim().max(30).regex(/^[\d\s/.RrXx-]*$/).default(''),
  situacao:z.enum(['todos','zerado','repor']).default('todos'),
  tipo_veiculo:z.enum(['all','motorcycle','car']).default('all'),pagina:z.number().int().min(1).max(10000).default(1)}).strict();
export const deliveryInput = z.object({situacao:z.enum(['todas_abertas','pendentes','em_entrega','problemas']).default('todas_abertas')}).strict();
export const financeInput = z.object({mes:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  visao:z.enum(['resumo','a_receber','a_pagar']).default('resumo'),pagina:z.number().int().min(1).max(10000).default(1)}).strict();

const expandedSchemas=Object.fromEntries(Object.entries(expandedTools).map(([key,value])=>[key,value.schema])) as
  {[K in ExpandedToolName]:typeof expandedTools[K]['schema']};
export const dotSchemas = {...expandedSchemas,consultar_resumo_matriz:periodInput,consultar_vendas_matriz:periodInput,
  consultar_estoque_matriz:stockInput,consultar_entregas_matriz:deliveryInput,consultar_financeiro_matriz:financeInput,
  consultar_reposicao_matriz:stockInput,consultar_relatorios_matriz:reportInput};
export type DotToolName = keyof typeof dotSchemas;

export async function runDotConsultation(name:DotToolName,raw:unknown):Promise<Record<string,unknown>> {
  const metadata={environment:env.FAREJADOR_ENV,timezone:'America/Sao_Paulo',currency:'BRL',
    read_at:new Date().toISOString(),scope:'matriz',read_only:true};
  if(name==='consultar_relatorios_matriz') {
    const target=reportTarget(reportInput.parse(raw));
    return {...await runDotConsultation(target.name,target.input),report:target.area,export_format:'json',
      export_warning:'Relatório paginado com os mesmos filtros e proteções das consultas. Não é uma exportação irrestrita do banco.'};
  }
  if(Object.hasOwn(expandedTools,name)) {
    return {...metadata,...await withDotReadOnly(db=>expandedTools[name as ExpandedToolName].run(db,raw))};
  }
  if(name==='consultar_estoque_matriz'||name==='consultar_reposicao_matriz') {
    const input=stockInput.parse(raw),filter=stockReportQuery.parse({measure:input.medida,
      status:name==='consultar_reposicao_matriz'?'replenish':input.situacao==='zerado'?'zero':input.situacao==='repor'?'replenish':'all',vehicle_type:input.tipo_veiculo});
    // The existing report already opens its own REPEATABLE READ READ ONLY snapshot.
    const report=await getStockReport(filter,env.FAREJADOR_ENV);
    const offset=(input.pagina-1)*50;
    return {...metadata,as_of:report.as_of,summary:report.summary,total:report.groups.length,page:input.pagina,page_size:50,
      truncated:report.groups.length>offset+50,
      products:report.groups.slice(offset,offset+50).map(row=>({measure:row.measure,condition:row.condition,vehicle_type:row.vehicle_type,
        physical:row.physical,reserved:row.reserved,available:row.available,incoming:row.incoming,minimum:row.minimum,
        suggested:row.suggested,status:row.status,sold_30d:row.sold,coverage_days:row.coverage_days})),
      warning:'Estoque da Matriz. Mínimo não definido é desconhecido, não significa estoque suficiente.'};
  }
  const data=await withDotReadOnly(async db=>{
    if(name==='consultar_entregas_matriz')return readDotDeliveries(db,deliveryInput.parse(raw).situacao);
    if(name==='consultar_financeiro_matriz') {
      const input=financeInput.parse(raw),month=dotPeriod({periodo:'mes',mes:input.mes}).month;
      return readDotFinanceDetails(db,month,input.visao,input.pagina);
    }
    const period=dotPeriod(periodInput.parse(raw));
    const sales=await readOverviewSales(db,env.FAREJADOR_ENV,period.from,period.to);
    return {period,sales,...(name==='consultar_resumo_matriz'?{attention:await readOverviewAttention(db,env.FAREJADOR_ENV)}:{}),
      monetary_unit:'centavos',warning:'Receita comercial das vendas realizadas; não equivale a dinheiro recebido nem a lucro.'};
  });
  return {...metadata,...data};
}
