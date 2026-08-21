import type { PartnerContext } from './auth.js';
import { withPartnerContext } from './db.js';
import { simpleFinanceRangeDays, type SimpleFinanceRange } from '../shared/simple-finance.js';
import type {
  OperationFinanceEntriesPayload,
  OperationFinanceEntry,
  OperationFinanceEntryKind,
} from '../shared/finance-entries.js';

interface PartnerFinanceEntryRow {
  id: string;
  kind: OperationFinanceEntryKind;
  title: string | null;
  subtitle: string | null;
  origin: string;
  payment_method: string | null;
  amount: string;
  entry_date: string;
  occurred_at: string;
  total_amount: string;
  total_count: number;
}

export async function getPartnerFinanceEntries(
  ctx: PartnerContext,
  range: SimpleFinanceRange,
): Promise<OperationFinanceEntriesPayload> {
  const days = simpleFinanceRangeDays(range);
  const result = await withPartnerContext(ctx.partnerUnitId, async (client) => client.query<PartnerFinanceEntryRow>(
    `WITH bounds AS (
       SELECT ((date_trunc('day',now() AT TIME ZONE 'America/Sao_Paulo')
                - (($3::int-1)*interval '1 day')) AT TIME ZONE 'America/Sao_Paulo') start_at,
              ((date_trunc('day',now() AT TIME ZONE 'America/Sao_Paulo')
                + interval '1 day') AT TIME ZONE 'America/Sao_Paulo') end_at
     ), entries AS (
       SELECT po.id::text id,'sale'::text kind,
              COALESCE(NULLIF(btrim(po.customer_name),''),'Venda no balcão') title,
               COALESCE(items.summary,'Itens da venda') subtitle,
               'Venda'::text origin,po.payment_method,po.total_amount amount,
               to_char(realized.realized_at AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD') entry_date,
               realized.realized_at occurred_at
          FROM commerce.partner_orders po,bounds b
          CROSS JOIN LATERAL (SELECT CASE
            WHEN po.fulfillment_mode='delivery' THEN po.delivered_at
            ELSE COALESCE(po.retrieved_at,po.created_at) END realized_at) realized
         LEFT JOIN LATERAL (
           SELECT CASE WHEN count(*)=0 THEN NULL
                  WHEN count(*)=1 THEN max(COALESCE(NULLIF(btrim(brand||' '||tire_size),''),item_name))
                  ELSE max(COALESCE(NULLIF(btrim(brand||' '||tire_size),''),item_name))
                       ||' + '||(count(*)-1)::text||' item(ns)' END summary
             FROM commerce.partner_order_items
            WHERE environment=po.environment AND order_id=po.id
         ) items ON true
         WHERE po.environment=$1 AND po.unit_id=$2 AND po.status<>'cancelled'
           AND po.deleted_at IS NULL
           AND NOT (po.fulfillment_mode='delivery'
             AND po.delivery_status<>'delivered')
           AND NOT po.awaiting_pickup
           AND realized.realized_at>=b.start_at AND realized.realized_at<b.end_at
           AND (po.payment_method IS NULL OR po.payment_method<>'A receber')
       UNION ALL
       SELECT COALESCE(pre.installment_id,pre.receivable_id)::text,'receivable'::text,
              COALESCE(NULLIF(btrim(pr.customer_name),''),'Conta recebida'),
              COALESCE(NULLIF(btrim(pr.description),''),'Recebimento confirmado'),
              'Conta recebida'::text,
              COALESCE(pri.payment_method,pr.payment_method),pre.amount,
              to_char(pre.received_at AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD'),
              pre.received_at
         FROM finance.partner_receivables_effective pre
         JOIN finance.partner_receivables pr
           ON pr.environment=pre.environment AND pr.id=pre.receivable_id
         LEFT JOIN finance.partner_receivable_installments pri
           ON pri.environment=pre.environment AND pri.id=pre.installment_id
         CROSS JOIN bounds b
        WHERE pre.environment=$1 AND pre.unit_id=$2 AND pre.status='received'
          AND pre.received_at>=b.start_at AND pre.received_at<b.end_at
     ), counted AS (
       SELECT *,sum(amount) OVER()::text total_amount,count(*) OVER()::int total_count
         FROM entries
     )
     SELECT * FROM counted ORDER BY occurred_at DESC,id DESC LIMIT 200`,
    [ctx.environment, ctx.unitId, days],
  ));
  const rows: OperationFinanceEntry[] = result.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title ?? 'Entrada',
    subtitle: row.subtitle ?? row.origin,
    origin: row.origin,
    payment_method: row.payment_method,
    amount: Number(row.amount),
    entry_date: row.entry_date,
    occurred_at: row.occurred_at,
  }));
  return {
    range,
    total: Number(result.rows[0]?.total_amount ?? 0),
    count: Number(result.rows[0]?.total_count ?? 0),
    visible_count: rows.length,
    rows,
  };
}
