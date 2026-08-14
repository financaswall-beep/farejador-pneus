import type { PartnerContext } from './auth.js';
import { withPartnerContext } from './db.js';
import { simpleFinanceRangeDays, type SimpleFinanceRange } from '../shared/simple-finance.js';
import type {
  OperationFinanceEntriesPayload,
  OperationFinanceEntry,
  OperationFinanceEntryKind,
} from '../shared/finance-entries.js';

interface PartnerFinanceOutputRow {
  id: string;
  kind: OperationFinanceEntryKind;
  title: string | null;
  subtitle: string | null;
  origin: string;
  payment_method: string | null;
  amount: string;
  entry_date: string;
  occurred_at: string | null;
  total_amount: string;
  total_count: number;
}

export async function getPartnerFinanceOutputs(
  ctx: PartnerContext,
  range: SimpleFinanceRange,
): Promise<OperationFinanceEntriesPayload> {
  const days = simpleFinanceRangeDays(range);
  const result = await withPartnerContext(ctx.partnerUnitId, async (client) =>
    client.query<PartnerFinanceOutputRow>(
      `WITH bounds AS (
         SELECT ((date_trunc('day',now() AT TIME ZONE 'America/Sao_Paulo')
                  - (($3::int-1)*interval '1 day')) AT TIME ZONE 'America/Sao_Paulo') start_at,
                ((date_trunc('day',now() AT TIME ZONE 'America/Sao_Paulo')
                  + interval '1 day') AT TIME ZONE 'America/Sao_Paulo') end_at,
                ((now() AT TIME ZONE 'America/Sao_Paulo')::date-($3::int-1)) start_date,
                ((now() AT TIME ZONE 'America/Sao_Paulo')::date+1) end_date
       ), outputs AS (
         SELECT pp.id::text,'purchase'::text kind,
                COALESCE(NULLIF(btrim(pp.supplier_name),''),'Compra de estoque') title,
                COALESCE(NULLIF(btrim(pp.notes),''),'Compra paga no ato') subtitle,
                'Compra'::text origin,pp.payment_method,pp.total_amount amount,
                to_char(pp.purchased_at AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD') entry_date,
                pp.purchased_at occurred_at
           FROM commerce.partner_purchases pp,bounds b
          WHERE pp.environment=$1 AND pp.unit_id=$2 AND pp.deleted_at IS NULL
            AND pp.payment_status='paid_now'
            AND pp.purchased_at>=b.start_at AND pp.purchased_at<b.end_at
         UNION ALL
         SELECT pe.id::text,'expense'::text,
                COALESCE(NULLIF(btrim(pe.description),''),'Despesa'),
                COALESCE(NULLIF(btrim(pe.category),''),'Despesa da loja'),
                'Despesa'::text,pe.payment_method,pe.amount,pe.expense_date::text,
                NULL::timestamptz
           FROM finance.partner_expenses pe,bounds b
          WHERE pe.environment=$1 AND pe.unit_id=$2 AND pe.deleted_at IS NULL
            AND pe.source_payable_id IS NULL
            AND pe.expense_date>=b.start_date AND pe.expense_date<b.end_date
         UNION ALL
         SELECT p.id::text,'payable'::text,
                COALESCE(NULLIF(btrim(p.counterparty_name),''),'Conta paga'),
                COALESCE(NULLIF(btrim(p.description),''),'Pagamento confirmado'),
                'Conta paga'::text,p.payment_method,p.amount,
                to_char(p.paid_at AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD'),p.paid_at
           FROM finance.partner_payables p,bounds b
          WHERE p.environment=$1 AND p.unit_id=$2 AND p.deleted_at IS NULL
            AND p.status='paid' AND p.paid_at>=b.start_at AND p.paid_at<b.end_at
       ), counted AS (
         SELECT *,sum(amount) OVER()::text total_amount,count(*) OVER()::int total_count
           FROM outputs
       )
       SELECT * FROM counted
        ORDER BY entry_date DESC,occurred_at DESC NULLS LAST,id DESC LIMIT 200`,
      [ctx.environment, ctx.unitId, days],
    ));
  const rows: OperationFinanceEntry[] = result.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title ?? 'Saída',
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
