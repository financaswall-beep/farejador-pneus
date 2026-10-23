import type { Pool } from 'pg';
import { env } from '../../shared/config/env.js';
import { MAIN_DELIVERY_GUARD } from '../painel/queries-logistica-read.js';

export async function readDotDeliveries(db: Pool, situation: 'todas_abertas'|'pendentes'|'em_entrega'|'problemas') {
  if (!env.MATRIZ_LOGISTICS) return {available:false,reason:'logistics_disabled'};
  const statuses = situation === 'pendentes' ? ['pending'] : situation === 'em_entrega' ? ['dispatched']
    : situation === 'problemas' ? ['failed'] : ['pending','dispatched','failed'];
  const result = await db.query(`SELECT o.order_number,o.delivery_status,o.total_amount::text,
    COALESCE(o.scheduled_delivery_date,((o.created_at AT TIME ZONE 'America/Sao_Paulo')::date+1))::text scheduled_date,
    o.created_at,o.dispatched_at,count(*) OVER()::int total
    FROM commerce.orders o WHERE o.environment=$1 AND ${MAIN_DELIVERY_GUARD}
      AND o.status<>'cancelled' AND o.delivery_status=ANY($2::text[])
    ORDER BY scheduled_date,o.created_at,o.id LIMIT 51`,[env.FAREJADOR_ENV,statuses]);
  const receipts = await db.query(`SELECT count(*)::int pending FROM commerce.matriz_trip_receipts
    WHERE environment=$1 AND workflow_status IN ('uploaded','processing','review_required')`,[env.FAREJADOR_ENV]);
  return {available:true,situacao:situation,total:result.rows[0]?.total ?? 0,
    truncated:result.rows.length>50,notas_aguardando_conferencia:receipts.rows[0].pending,
    deliveries:result.rows.slice(0,50).map(row=>({order_number:row.order_number,status:row.delivery_status,
      amount_brl:row.total_amount,scheduled_date:row.scheduled_date,created_at:row.created_at,dispatched_at:row.dispatched_at}))};
}
