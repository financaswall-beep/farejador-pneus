import { z } from 'zod';
import { businessDateSaoPaulo, isNotFutureBusinessDate } from '../../shared/business-time.js';
import { calculateLotPurchaseMoney } from './lot-purchase-money.js';

export const registerLotPurchaseSchema = z.object({
  supplier_id: z.string().uuid().optional(),
  new_supplier: z.object({ name: z.string().trim().min(1).max(200),
    phone: z.string().max(40).nullable().optional(), document: z.string().max(30).nullable().optional(),
  }).optional(),
  lot: z.object({ vehicle_type: z.enum(['motorcycle','car','mixed']).nullable().optional(), description: z.string().trim().min(1).max(200),
    quantity: z.number().int().positive().max(100000), total_cost: z.number().positive(), }).strict(),
  purchased_at: z.string().datetime({ offset: true }),
  received_at: z.string().datetime({ offset: true }).optional(),
  paid_at: z.string().datetime({ offset: true }).optional(),
  supplier_reference: z.string().trim().min(1).max(160).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
  freight_amount: z.number().min(0).default(0),
  discount_amount: z.number().min(0).default(0),
  payment_status: z.enum(['paid', 'pending']),
  payment_method: z.string().trim().min(1).max(60).optional(),
  due_date: z.string().date().optional(),
  receipt_status: z.enum(['pending', 'received']),
  idempotency_key: z.string().min(8).max(200),
}).strict().superRefine((d, ctx) => {
  const issue = (message: string, path: string) => ctx.addIssue({
    code: z.ZodIssueCode.custom, message, path: [path],
  });
  if (!!d.supplier_id === !!d.new_supplier) issue('supplier_required', 'supplier_id');
  for (const field of ['purchased_at', 'received_at', 'paid_at'] as const) {
    if (d[field] && !isNotFutureBusinessDate(d[field])) issue(`${field}_future`, field);
  }
  if (d.receipt_status === 'received' && !d.received_at) issue('received_at_required', 'received_at');
  if (d.received_at && businessDateSaoPaulo(d.received_at) < businessDateSaoPaulo(d.purchased_at)) {
    issue('received_before_purchase', 'received_at');
  }
  if (d.payment_status === 'pending' && !d.due_date) issue('due_date_required', 'due_date');
  if (d.payment_status === 'paid' && (!d.paid_at || !d.payment_method)) issue('payment_details_required', 'paid_at');
  if (d.due_date && d.due_date < businessDateSaoPaulo(d.purchased_at)) issue('due_date_before_purchase', 'due_date');
  try {
    const total = calculateLotPurchaseMoney(d.lot, d.freight_amount, d.discount_amount);
    if (total.totalCents <= 0) issue('lot_total_cost_invalid', 'lot');
  } catch (error) { issue(error instanceof Error ? error.message : 'lot_total_cost_invalid', 'lot'); }
});
