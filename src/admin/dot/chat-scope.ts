import type { Pool } from 'pg';
import { env } from '../../shared/config/env.js';

/** A missing setting is safe only when the environment has one unambiguous account. */
export async function dotChatwootAccount(db:Pool):Promise<number|null> {
  if(env.CHATWOOT_ACCOUNT_ID!==undefined)return env.CHATWOOT_ACCOUNT_ID>0?env.CHATWOOT_ACCOUNT_ID:null;
  const result=await db.query(`SELECT DISTINCT chatwoot_account_id FROM core.conversations
    WHERE environment=$1 AND deleted_at IS NULL ORDER BY chatwoot_account_id LIMIT 2`,[env.FAREJADOR_ENV]);
  const id=Number(result.rows[0]?.chatwoot_account_id);
  return result.rows.length===1&&Number.isSafeInteger(id)&&id>0?id:null;
}
