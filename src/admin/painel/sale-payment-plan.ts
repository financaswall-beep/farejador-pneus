import { z } from 'zod';

const money = z.number().finite().nonnegative().max(9_999_999_999.99).multipleOf(0.01);
export const salePaymentPlanSchema = z.object({
  received: money,
  method: z.enum(['Pix', 'Dinheiro', 'Cartão']).optional(),
  installments: z.array(z.object({
    due_date: z.string().date(), amount: money.positive(),
  }).strict()).min(1).max(120),
}).strict();
export type SalePaymentPlan = z.infer<typeof salePaymentPlanSchema>;
export type SalePaymentSnapshot = {
  received: number; balance: number; next_due: string | null;
  installments: Array<{ number: number; due_date: string; amount: number; balance: number }>;
};

export function validateSalePaymentPlan(plan: SalePaymentPlan, totalCents: number,
  status: string | undefined, soldOn: string, dueDate?: string | null) {
  salePaymentPlanSchema.parse(plan);
  if (status !== 'pending' || plan.received > 0 && !plan.method
    || dueDate !== plan.installments[0]?.due_date) throw new Error('sale_plan_invalid');
  let previousDate = soldOn;
  let sum = Math.round(plan.received * 100);
  for (const installment of plan.installments) {
    if (installment.due_date < previousDate) throw new Error('sale_plan_dates_invalid');
    previousDate = installment.due_date;
    sum += Math.round(installment.amount * 100);
  }
  if (sum !== totalCents) throw new Error('sale_plan_total_mismatch');
}

// O acordo fica na receita imutável. Baixas sem parcela explícita (inclusive
// perdas) abatem as mais antigas. Estornos seguem a parcela do pagamento original.
export const salePlanSnapshotSql = `CASE WHEN t.metadata ? 'sale_plan' THEN (
  WITH payments AS (
    SELECT CASE WHEN p.payment_kind='reversal' THEN -p.amount ELSE p.amount END amount,
           p.payment_kind,
           (COALESCE(original_tx.metadata,tx.metadata)->>'sale_installment')::int number
      FROM finance.matriz_ledger_payments p
      JOIN finance.matriz_ledger_transactions tx ON tx.id=p.payment_transaction_id
      LEFT JOIN finance.matriz_ledger_payments original ON original.id=p.reversal_of_payment_id
      LEFT JOIN finance.matriz_ledger_transactions original_tx ON original_tx.id=original.payment_transaction_id
     WHERE p.environment=t.environment AND p.obligation_transaction_id=t.id
  ), totals AS (
    SELECT COALESCE(sum(amount) FILTER (WHERE payment_kind IN ('settlement','reversal')),0) received,
           COALESCE(sum(amount) FILTER (WHERE number IS NULL),0)
             - (t.metadata->'sale_plan'->>'received')::numeric generic
      FROM payments
  ), corrections AS MATERIALIZED (
    -- to_jsonb mantém a leitura compatível durante o deploy das colunas opcionais.
    SELECT to_jsonb(o)->'installment_due_dates' dates, NULLIF(to_jsonb(o)->'installment_agreement','null'::jsonb) parts
      FROM commerce.wholesale_orders o
     WHERE o.environment=t.environment AND o.id=t.source_id::uuid
  ), parts AS (
    SELECT n, COALESCE(dates->>n::text,part->>'due_date') due_date,(part->>'amount')::numeric amount,
           (part->>'amount')::numeric-COALESCE((SELECT sum(amount) FROM payments WHERE number=n),0) unallocated
      FROM jsonb_array_elements(COALESCE((SELECT parts FROM corrections),t.metadata->'sale_plan'->'installments')) WITH ORDINALITY AS plan(part,n)
      LEFT JOIN corrections ON true
  ), balances AS (
    SELECT parts.*, GREATEST(0,LEAST(unallocated,
             sum(unallocated) OVER (ORDER BY n)-totals.generic)) balance
      FROM parts CROSS JOIN totals
  )
  SELECT jsonb_build_object('received',(SELECT received FROM totals),'balance',sum(balance),
           'next_due',min(due_date) FILTER (WHERE balance>0),
           'installments',jsonb_agg(jsonb_build_object('number',n,'due_date',due_date,
             'amount',amount,'balance',balance) ORDER BY n))
    FROM balances
) END`;

export const orderSalePlanSql = `(SELECT ${salePlanSnapshotSql}
  FROM finance.matriz_ledger_transactions t WHERE t.environment=o.environment
    AND t.source_type IN ('commerce.wholesale_order.revenue','commerce.wholesale_order.arrival_revenue')
    AND t.metadata ? 'sale_plan' AND t.source_id=o.id::text)`;
