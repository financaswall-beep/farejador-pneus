import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';

export interface WholesaleBuyerRow {
  customer_id: string | null;
  partner_id: string | null;
  name: string;
  phone: string | null;
  is_partner: boolean;
  partner_units: Array<{
    partner_unit_id: string;
    unit_id: string;
    display_name: string;
  }>;
}

export async function listWholesaleBuyers(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<WholesaleBuyerRow[]> {
  const result = await dbPool.query<WholesaleBuyerRow>(
    `SELECT c.id AS customer_id,c.partner_id,c.name,c.phone,
            (c.partner_id IS NOT NULL) AS is_partner,
            COALESCE((SELECT json_agg(json_build_object(
              'partner_unit_id',pu.id,'unit_id',pu.unit_id,'display_name',pu.display_name)
              ORDER BY pu.created_at,pu.id)
              FROM network.partner_units pu
             WHERE pu.environment=c.environment AND pu.partner_id=c.partner_id
               AND pu.status='active' AND pu.deleted_at IS NULL),'[]'::json) AS partner_units
       FROM commerce.wholesale_customers c
      WHERE c.environment=$1 AND c.deleted_at IS NULL
     UNION ALL
     SELECT NULL::uuid,p.id,p.trade_name,p.whatsapp_phone,true,
            COALESCE((SELECT json_agg(json_build_object(
              'partner_unit_id',pu.id,'unit_id',pu.unit_id,'display_name',pu.display_name)
              ORDER BY pu.created_at,pu.id)
              FROM network.partner_units pu
             WHERE pu.environment=p.environment AND pu.partner_id=p.id
               AND pu.status='active' AND pu.deleted_at IS NULL),'[]'::json)
       FROM network.partners p
      WHERE p.environment=$1 AND p.deleted_at IS NULL AND p.status='active'
        AND NOT EXISTS (SELECT 1 FROM commerce.wholesale_customers c
          WHERE c.environment=p.environment AND c.partner_id=p.id AND c.deleted_at IS NULL)
     ORDER BY name`,
    [environment],
  );
  return result.rows;
}

export async function getWholesaleRanking(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV,
  dbPool: Pool = defaultPool,
): Promise<unknown[]> {
  const result = await dbPool.query(
    `SELECT buyer_id,partner_id,name,phone,is_partner,orders_count,total_bought,last_purchase_at,days_since_last
       FROM commerce.wholesale_buyer_summary WHERE environment=$1
     UNION ALL
     SELECT NULL::uuid,p.id,p.trade_name,p.whatsapp_phone,true,0,0::numeric,NULL::timestamptz,NULL::int
       FROM network.partners p
      WHERE p.environment=$1 AND p.deleted_at IS NULL AND p.status='active'
        AND NOT EXISTS (SELECT 1 FROM commerce.wholesale_customers c
          WHERE c.environment=p.environment AND c.partner_id=p.id AND c.deleted_at IS NULL)
     ORDER BY total_bought DESC,last_purchase_at DESC NULLS LAST,name`,
    [environment],
  );
  return result.rows;
}
