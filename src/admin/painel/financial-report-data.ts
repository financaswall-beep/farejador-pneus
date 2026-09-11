import type { Pool } from 'pg';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { getMatrizLedgerIntegrationHealth } from './matriz-ledger-integration-health.js';
import { MatrizCentralLedgerUnavailableError } from './queries-financeiro-read-switch.js';
import { getMatrizLedgerOpenItems } from './matriz-ledger-open-items.js';
import { financialMovementsSql,financialOpeningSql,financialPendingCostSql } from './financial-report-sql.js';
import { FinancialReportLimitError,type FinancialReportFilter } from './financial-report-filter.js';
import type { FinancialSnapshot,FinancialMovement,FinancialTitle } from './financial-report-types.js';

const titleOrigins:Record<string,string>={fiado:'atacado',varejo:'varejo',comissao:'comissao',mensalidade:'mensalidades',
  fornecedor:'compras',devolucao_fornecedor:'compras',despesa:'despesas',folha:'despesas',devolucao_despesa:'despesas',
  estorno_comissao:'comissao',marketing:'marketing',devolucao_cliente:'financeiro'};
export async function readFinancialSnapshot(filter:FinancialReportFilter,environment=env.FAREJADOR_ENV,db:Pool=pool):Promise<FinancialSnapshot>{
  if(!env.MATRIZ_CENTRAL_LEDGER||!env.MATRIZ_CENTRAL_LEDGER_READ)throw new MatrizCentralLedgerUnavailableError('disabled');
  const client=await db.connect();
  try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await client.query("SET LOCAL statement_timeout='15s'");
    const reader={query:client.query.bind(client)} as Pool;
    const health=await getMatrizLedgerIntegrationHealth(environment,reader);
    if(health.status==='red'||health.status==='disabled')throw new MatrizCentralLedgerUnavailableError(`integration_${health.status}`);
    const clock=(await client.query<{as_of:Date;today:string}>("SELECT now() AS as_of,(now() AT TIME ZONE 'America/Sao_Paulo')::date::text AS today")).rows[0]!;
    const params=[environment,filter.from,filter.to];
    const movements=(await client.query<FinancialMovement>(financialMovementsSql,params)).rows;
    if(movements.length>20000)throw new FinancialReportLimitError('financial_report_limit');
    const opening=(await client.query<FinancialSnapshot['opening'][number]>(financialOpeningSql,[environment,filter.from])).rows;
    const pending=(await client.query<FinancialSnapshot['pending_cost'][number]>(financialPendingCostSql,params)).rows;
    const agenda=await getMatrizLedgerOpenItems(environment,reader),titles:FinancialTitle[]=[];
    for(const [side,items] of [['receivable',agenda.a_receber.itens],['payable',agenda.a_pagar.itens]] as const)for(const item of items){
      titles.push({id:side+':'+item.tipo+':'+item.id,source_id:item.id,obligation_id:item.obligation_id||null,side,type:item.tipo,
        name:item.nome,amount:Number(item.valor),due_on:item.due_date,category:item.categoria||null,
        count:'count' in item?item.count||1:1,origin:titleOrigins[item.tipo]||'outros'});
    }
    if(titles.length>10000)throw new FinancialReportLimitError('financial_report_limit');
    await client.query('COMMIT');
    return{as_of:clock.as_of.toISOString(),today:clock.today,integration_status:health.status,movements,opening,titles,pending_cost:pending};
  }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
}
