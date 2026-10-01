import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { pool } from '../persistence/db.js';
import { env } from '../shared/config/env.js';

export const googleClickInput=z.object({
  campaign_id:z.string().regex(/^\d+$/).max(30),ad_group_id:z.string().regex(/^\d+$/).max(30),ad_id:z.string().regex(/^\d+$/).max(30),
  identifier_type:z.enum(['gclid','gbraid','wbraid']),identifier:z.string().regex(/^[A-Za-z0-9_-]{1,512}$/),
  consent_ad_user_data:z.literal(true),consent_ad_personalization:z.boolean().default(false),destination:z.enum(['whatsapp','web']),
}).strict();

export async function registerGoogleClick(input:z.infer<typeof googleClickInput>,dbPool:Pool=pool):Promise<string|null> {
  const parsed=googleClickInput.parse(input),account=env.GOOGLE_ADS_CUSTOMER_ID;
  if(!env.GOOGLE_ADS_ENABLED||!account) return null;
  const hash=createHash('sha256').update(`${parsed.identifier_type}:${parsed.identifier}`).digest('hex');
  const reference=`2W-G${randomBytes(16).toString('hex')}`;
  const result=await dbPool.query<{reference:string}>(`INSERT INTO marketing.google_clicks
    (environment,account_id,campaign_id,ad_group_id,ad_id,reference,identifier_type,identifier,identifier_hash,
      consent_ad_user_data,consent_ad_personalization,destination)
    SELECT a.environment,a.account_id,a.campaign_id,a.ad_group_id,a.ad_id,$6,$7,$8,$9,true,$10,$11
    FROM marketing.google_ads a JOIN marketing.google_campaigns c USING(environment,account_id,campaign_id)
    WHERE a.environment=$1 AND a.account_id=$2 AND a.campaign_id=$3 AND a.ad_group_id=$4 AND a.ad_id=$5 AND c.owned
    ON CONFLICT(environment,account_id,identifier_hash) DO NOTHING RETURNING reference`,
  [env.FAREJADOR_ENV,account,parsed.campaign_id,parsed.ad_group_id,parsed.ad_id,reference,parsed.identifier_type,parsed.identifier,hash,parsed.consent_ad_personalization,parsed.destination]);
  if(result.rows[0])return result.rows[0].reference;
  // Nao alterar consentimento ou destino de clique previamente observado.
  const previous=await dbPool.query<{reference:string}>(`SELECT g.reference FROM marketing.google_clicks g
    JOIN marketing.google_campaigns c USING(environment,account_id,campaign_id)
    WHERE g.environment=$1 AND g.account_id=$2 AND g.identifier_hash=$3 AND g.campaign_id=$4
      AND g.ad_group_id=$5 AND g.ad_id=$6 AND g.destination=$7 AND c.owned
      AND g.captured_at>now()-interval '7 days'`,
  [env.FAREJADOR_ENV,account,hash,parsed.campaign_id,parsed.ad_group_id,parsed.ad_id,parsed.destination]);
  return previous.rows[0]?.reference??null;
}
