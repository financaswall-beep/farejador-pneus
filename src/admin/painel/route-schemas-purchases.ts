import { z } from 'zod';
import { businessDateSaoPaulo, isNotFutureBusinessDate } from '../../shared/business-time.js';
import { assertWholesalePurchaseMoney, hasCentPrecision } from './purchase-money.js';

const idempotencyKeySchema = z.string().min(8).max(200);
const tireConditionSchema = z.enum(['meia_vida', 'novo', 'remold']);

const saoPauloDate = businessDateSaoPaulo;

export const registerSupplierSchema = z.object({
  name: z.string().min(1).max(200),
  phone: z.string().max(40).nullable().optional(),
  document: z.string().max(30).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
});

export const purchaseItemSchema = z.object({
  measure: z.string().min(1).max(60),
  brand: z.string().trim().min(1, 'brand_required').max(60),
  tire_condition: tireConditionSchema,
  quantity: z.number().int('quantidade_inteira').positive().max(100000),
  unit_cost: z.number().min(0).max(9999999.99).refine(hasCentPrecision, {
    message: 'unit_cost_cent_precision',
  }),
});

export const registerPurchaseSchema = z.object({
  supplier_id: z.string().uuid().nullable().optional(),
  new_supplier: z.object({
    name: z.string().min(1).max(200), phone: z.string().max(40).nullable().optional(),
    document: z.string().max(30).nullable().optional(),
  }).nullable().optional(),
  items: z.array(purchaseItemSchema).min(1).max(50),
  purchased_at: z.string().datetime({ offset: true }).nullable().optional(),
  paid_at: z.string().datetime({ offset: true }).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  payment_status: z.enum(['paid', 'pending']).optional(),
  due_date: z.string().date().nullable().optional(),
  receipt_status: z.enum(['pending', 'received']).default('received'),
  idempotency_key: idempotencyKeySchema,
}).refine(
  (d) => !!d.supplier_id || !!d.new_supplier?.name.trim(),
  { message: 'supplier_required' },
).refine(
  (d) => d.payment_status !== 'pending' || Boolean(d.due_date),
  { message: 'due_date_required', path: ['due_date'] },
).refine(
  (d) => !d.purchased_at || isNotFutureBusinessDate(d.purchased_at),
  { message: 'purchased_at_future', path: ['purchased_at'] },
).refine(
  (d) => !d.paid_at || isNotFutureBusinessDate(d.paid_at),
  { message: 'paid_at_future', path: ['paid_at'] },
).refine(
  (d) => !d.purchased_at || !d.due_date || d.due_date >= saoPauloDate(d.purchased_at),
  { message: 'due_date_before_purchase', path: ['due_date'] },
).superRefine((d, ctx) => {
  try {
    assertWholesalePurchaseMoney(d.items);
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : 'purchase_total_invalid',
      path: ['items'],
    });
  }
});

export const cancelWholesalePurchaseSchema = z.object({
  purchase_id: z.string().uuid(), reason: z.string().trim().min(2).max(300),
  idempotency_key: idempotencyKeySchema,
});
export const confirmWholesalePurchaseSchema = z.object({
  purchase_id: z.string().uuid(), idempotency_key: idempotencyKeySchema,
});
export const archiveWholesaleSupplierSchema = z.object({ supplier_id: z.string().uuid() });
