import type { Pool } from 'pg';
import { pool } from '../../persistence/db.js';

/** Only this transaction's query method is exposed. No escape to the shared pool. */
export async function withDotReadOnly<T>(work: (db: Pool) => Promise<T>, db: Pool = pool): Promise<T> {
  const client = await db.connect();
  let pending:Promise<void>=Promise.resolve();
  const query=((...args:unknown[])=>{
    const result=pending.then(()=>Reflect.apply(client.query,client,args) as Promise<unknown>);
    pending=result.then(()=>undefined,()=>undefined);
    return result;
  }) as Pool['query'];
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='15s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout='20s'");
    const result = await work({query} as Pool);
    await pending;
    await client.query('COMMIT');
    return result;
  } catch (error) { await pending; await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}
