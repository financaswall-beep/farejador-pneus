import type { Pool } from 'pg';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { reportComparison } from './report-period.js';
import { PartnerReportLimitError,type PartnerReportFilter } from './partner-report-filter.js';
import type { PartnerSnapshot,ReportPartnerUnit,ReportPartnerSale,ReportPartnerCommission } from './partner-report-types.js';
import { partnerUnitsSql,partnerSalesSql,partnerCommissionsSql } from './partner-report-sql.js';
export async function readPartnerSnapshot(filter:PartnerReportFilter,environment=env.FAREJADOR_ENV,db:Pool=pool):Promise<PartnerSnapshot>{
  const client=await db.connect();
  try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await client.query("SET LOCAL statement_timeout='15s'");
    const comparison=reportComparison(filter),params=[environment,filter.from,filter.to,comparison?.from||null,comparison?.to||null];
    const clock=(await client.query<{as_of:Date;today:string}>("SELECT now() AS as_of,(now() AT TIME ZONE 'America/Sao_Paulo')::date::text AS today")).rows[0]!;
    const units=(await client.query<ReportPartnerUnit>(partnerUnitsSql,[environment])).rows;
    const sales=(await client.query<ReportPartnerSale>(partnerSalesSql,params)).rows;
    const commissions=env.NETWORK_COMMISSION_LEDGER?(await client.query<ReportPartnerCommission>(partnerCommissionsSql,params)).rows:[];
    if(units.length>2000||sales.length>20000||commissions.length>20000)throw new PartnerReportLimitError('partner_report_limit');
    await client.query('COMMIT');return{as_of:clock.as_of.toISOString(),today:clock.today,commission_enabled:env.NETWORK_COMMISSION_LEDGER,units,sales,commissions};
  }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
}
