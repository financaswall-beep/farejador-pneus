import type { Pool } from 'pg';
import { LogisticsReportLimitError, type LogisticsReportFilter } from './logistics-report-filter.js';
import type { LogisticsSnapshot, LogisticsTrip, LogisticsDelivery, LogisticsExpense, LogisticsReceipt } from './logistics-report-types.js';

/** Independent report queries: no 30-day dashboard cutoff and no operational writes. */
export async function readLogisticsSnapshot(db:Pool,environment:string,filter:LogisticsReportFilter):Promise<LogisticsSnapshot>{
  const client=await db.connect();
  const iso=(value:string|null)=>value?new Date(value).toISOString():null;
  const limited=<T>(rows:T[],maximum:number)=>{if(rows.length>maximum)throw new LogisticsReportLimitError('logistics_report_limit');return rows;};
  try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='15s'");
    const clock=await client.query<{as_of:Date}>('SELECT now() AS as_of');
    const trips=limited((await client.query<LogisticsTrip>(`SELECT t.id,t.trip_number AS number,t.courier_name AS courier,
      t.courier_collaborator_id AS courier_id,t.status,t.started_at::text,t.ended_at::text,
      (COALESCE(t.ended_at,t.started_at) AT TIME ZONE 'America/Sao_Paulo')::date::text AS day,
      t.km_start::float8,t.km_end::float8,t.fuel_spent::float8 AS fuel_recorded,
      commerce.matriz_trip_financial_status(t.id,t.environment) AS financial_status
      FROM commerce.matriz_delivery_trips t WHERE t.environment=$1 AND t.deleted_at IS NULL
        AND COALESCE(t.ended_at,t.started_at)>=($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
        AND COALESCE(t.ended_at,t.started_at)<(($3::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
        AND COALESCE(t.ended_at,t.started_at)<=now()
      ORDER BY COALESCE(t.ended_at,t.started_at) DESC,t.id DESC LIMIT 2001`,[environment,filter.from,filter.to])).rows,2000);
    const ids=trips.map(row=>row.id);
    const deliveries=limited((await client.query<LogisticsDelivery>(`SELECT o.id::text AS id,o.trip_id,o.id AS order_id,o.order_number AS number,
      COALESCE(c.name,cu.name) AS customer,o.delivery_status AS status,(o.status='cancelled') AS cancelled,
      o.delivery_failure_reason AS reason,o.scheduled_delivery_date::text AS scheduled,
      o.dispatched_at::text,o.delivered_at::text,false AS historical,
      CASE WHEN items.n>0 THEN GREATEST(o.total_amount-items.amount,0)::float8 ELSE NULL END AS freight
      FROM commerce.orders o JOIN core.units u ON u.id=o.unit_id AND u.environment=o.environment AND u.slug='main'
      LEFT JOIN core.contacts c ON c.id=o.contact_id AND c.environment=o.environment
      LEFT JOIN commerce.customers cu ON cu.id=o.customer_id AND cu.environment=o.environment
      LEFT JOIN LATERAL (SELECT count(*) AS n,sum(i.quantity*i.unit_price-i.discount_amount) AS amount
        FROM commerce.order_items i WHERE i.environment=o.environment AND i.order_id=o.id) items ON true
      WHERE o.environment=$1 AND o.trip_id=ANY($2::uuid[]) AND o.fulfillment_mode='delivery'
      UNION ALL
      SELECT 'history:'||a.id::text,t.id,a.entity_id::uuid,o.order_number,COALESCE(c.name,cu.name),'failed',false,
        a.payload_before->>'delivery_failure_reason',NULL,NULL,NULL,true,NULL
      FROM audit.events a JOIN commerce.matriz_delivery_trips t
        ON t.id::text=a.payload_before->>'trip_id' AND t.environment::text=a.environment
      LEFT JOIN commerce.orders o ON o.id::text=a.entity_id::text AND o.environment=t.environment
      LEFT JOIN core.contacts c ON c.id=o.contact_id AND c.environment=o.environment
      LEFT JOIN commerce.customers cu ON cu.id=o.customer_id AND cu.environment=o.environment
      WHERE a.environment=$1::text AND a.domain='matriz_logistics' AND a.entity_table='commerce.orders'
        AND a.event_type='delivery_report_detached_on_trip_close' AND t.id=ANY($2::uuid[])
      LIMIT 20001`,[environment,ids])).rows,20000);
    // DISTINCT expense id within each trip prevents the fuel link and several receipts counting twice.
    const expenses=limited((await client.query<LogisticsExpense>(`WITH links AS (
      SELECT t.id AS trip_id,t.fuel_expense_id AS expense_id FROM commerce.matriz_delivery_trips t
        WHERE t.environment=$1 AND t.id=ANY($2::uuid[]) AND t.fuel_expense_id IS NOT NULL
      UNION SELECT r.trip_id,r.ai_expense_id FROM commerce.matriz_trip_receipts r
        WHERE r.environment=$1 AND r.trip_id=ANY($2::uuid[]) AND r.workflow_status IN ('linked','legacy_linked')
    ) SELECT e.id,l.trip_id,e.category,e.amount::float8,e.occurred_at::text,
      ARRAY(SELECT r.id::text FROM commerce.matriz_trip_receipts r WHERE r.environment=e.environment
        AND r.trip_id=l.trip_id AND r.ai_expense_id=e.id AND r.workflow_status IN ('linked','legacy_linked') ORDER BY r.created_at) AS receipt_ids,
      NOT EXISTS(SELECT 1 FROM commerce.matriz_trip_receipts r WHERE r.environment=e.environment
        AND r.trip_id=l.trip_id AND r.ai_expense_id=e.id AND r.workflow_status='linked') AS legacy
      FROM links l JOIN commerce.matriz_expenses e ON e.id=l.expense_id AND e.environment=$1 AND e.deleted_at IS NULL
      ORDER BY e.occurred_at DESC,e.id LIMIT 20001`,[environment,ids])).rows,20000);
    const receipts=limited((await client.query<LogisticsReceipt>(`SELECT r.id,r.trip_id,r.created_at::text,r.workflow_status AS workflow,
      r.ai_expense_id AS expense_id,(r.workflow_status IN ('linked','legacy_linked') AND e.id IS NULL) AS missing_expense
      FROM commerce.matriz_trip_receipts r LEFT JOIN commerce.matriz_expenses e
        ON e.id=r.ai_expense_id AND e.environment=r.environment AND e.deleted_at IS NULL
      WHERE r.environment=$1 AND r.trip_id=ANY($2::uuid[]) ORDER BY r.created_at DESC,r.id LIMIT 20001`,[environment,ids])).rows,20000);
    await client.query('COMMIT');
    return {as_of:clock.rows[0]!.as_of.toISOString(),trips:trips.map(row=>({...row,started_at:iso(row.started_at)!,ended_at:iso(row.ended_at)})),
      deliveries:deliveries.map(row=>({...row,dispatched_at:iso(row.dispatched_at),delivered_at:iso(row.delivered_at)})),
      expenses:expenses.map(row=>({...row,occurred_at:iso(row.occurred_at)!})),receipts:receipts.map(row=>({...row,created_at:iso(row.created_at)!}))};
  }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
}
