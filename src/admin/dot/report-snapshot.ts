import type { Pool } from 'pg';

/** Adapts existing snapshot readers to the already open READ ONLY transaction.
 * They cannot obtain a real client, commit it, or escape to the shared pool. */
export function reportSnapshotPool(db:Pool):Pool {
  const query=(async(text:string,values?:unknown[])=>{
    if(text==='BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'||text==='COMMIT'||text==='ROLLBACK'
      ||text==="SET LOCAL statement_timeout='15s'")return {rows:[],rowCount:0};
    return db.query(text,values);
  }) as Pool['query'];
  return {query,connect:async()=>({query,release:()=>undefined})} as unknown as Pool;
}
