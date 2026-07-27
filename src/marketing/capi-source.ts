/** Fonte comum da CAPI: somente compras recentes o bastante para a Meta aceitar. */
import type { Pool } from 'pg';
import { env } from '../shared/config/env.js';

export interface CapiSourceRow {
  attribution_id: string;
  order_number: string;
  total_amount: string;
  realized_at: string;
  phone_e164: string | null;
  ctwa_clid: string;
  city_name: string | null;
  state_code: string | null;
  postal_code_prefix: string | null;
}

const CAPI_SOURCE_SQL = `
  SELECT a.id AS attribution_id,o.order_number,o.total_amount::text,
         a.realized_at::text,c.phone_e164,r.ctwa_clid,
         g.city_name,g.state_code,g.postal_code_prefix
    FROM marketing.order_attributions a
    JOIN marketing.ad_referrals r
      ON r.environment=a.environment AND r.id=a.referral_id
    JOIN commerce.orders o
      ON o.environment=a.environment AND o.id=a.order_id
    JOIN core.contacts c
      ON c.environment=o.environment AND c.id=o.contact_id
    LEFT JOIN commerce.geo_resolutions g
      ON g.environment=o.environment AND g.id=o.geo_resolution_id
   WHERE a.environment=$1 AND a.status='active' AND a.superseded_by IS NULL
     AND a.realized_at>=now()-interval '6 days 23 hours'`;

export async function loadProductionCapiSources(dbPool: Pool): Promise<CapiSourceRow[]> {
  const result = await dbPool.query<CapiSourceRow>(
    `${CAPI_SOURCE_SQL}
       AND NOT EXISTS (
         SELECT 1 FROM marketing.capi_outbox q
          WHERE q.environment=a.environment AND q.attribution_id=a.id
       )
     ORDER BY a.realized_at,a.id`,
    [env.FAREJADOR_ENV],
  );
  return result.rows;
}

export async function loadLatestCapiTestSource(
  dbPool: Pool,
): Promise<CapiSourceRow | null> {
  const result = await dbPool.query<CapiSourceRow>(
    `${CAPI_SOURCE_SQL}
     ORDER BY a.realized_at DESC,a.id DESC
     LIMIT 1`,
    [env.FAREJADOR_ENV],
  );
  return result.rows[0] ?? null;
}
