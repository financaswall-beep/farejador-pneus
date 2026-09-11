import type { Pool } from 'pg';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { demandEventsSql } from './demand-report-sql.js';
import { demandComparison,DemandReportLimitError,type DemandReportFilter } from './demand-report-filter.js';
import type { DemandEvent,DemandSnapshot } from './demand-report-types.js';
export async function readDemandSnapshot(f:DemandReportFilter,environment=env.FAREJADOR_ENV,db:Pool=pool):Promise<DemandSnapshot>{
  const c=await db.connect();try{
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await c.query("SET LOCAL statement_timeout='15s'");
    const asOf=(await c.query<{at:Date}>('SELECT now() AS at')).rows[0]!.at.toISOString();
    const current=(await c.query<DemandEvent>(demandEventsSql,[environment,f.from,f.to])).rows;
    const comparison=demandComparison(f),previous=comparison?(await c.query<DemandEvent>(demandEventsSql,[environment,comparison.from,comparison.to])).rows:[];
    const stock=(await c.query<{measure:string;quantity:number}>(`SELECT measure,sum(quantity_on_hand)::float8 AS quantity
      FROM commerce.wholesale_stock WHERE environment=$1 GROUP BY measure ORDER BY measure LIMIT 20001`,[environment])).rows;
    if(current.length>50000||previous.length>50000||stock.length>20000)throw new DemandReportLimitError();
    await c.query('COMMIT');return{as_of:asOf,current,previous,stock};
  }catch(error){await c.query('ROLLBACK').catch(()=>undefined);throw error;}finally{c.release();}
}
