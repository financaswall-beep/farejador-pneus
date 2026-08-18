import { z } from 'zod';

export const centMoneySchema = z.number().nonnegative().max(99_999_999.99).refine(
  (value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-7,
  'money_cent_precision',
);

export const sixDecimalCostSchema = z.number().nonnegative().max(999_999_999_999.999999)
  .refine(
    (value) => Math.abs(value * 1_000_000 - Math.round(value * 1_000_000)) < 1e-5,
    'cost_six_decimal_precision',
  );

const PARTNER_PURCHASE_MAX_CENTS = 9_999_999_999;

export function partnerPurchaseTotalCents(
  items: Array<{ quantity: number; unit_cost: number }>,
): number {
  if (!items.length) throw new Error('purchase_items_required');
  let total = 0;
  for (const item of items) {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0 || item.quantity > 999_999) {
      throw new Error('purchase_quantity_invalid');
    }
    const cents = Math.round((Number(item.unit_cost) + Number.EPSILON) * 100);
    if (!Number.isFinite(item.unit_cost) || cents < 0
        || Math.abs(item.unit_cost * 100 - cents) >= 1e-7) {
      throw new Error('purchase_unit_cost_invalid');
    }
    const line = item.quantity * cents;
    if (!Number.isSafeInteger(line) || line > PARTNER_PURCHASE_MAX_CENTS) {
      throw new Error('purchase_line_total_too_large');
    }
    total += line;
    if (!Number.isSafeInteger(total) || total > PARTNER_PURCHASE_MAX_CENTS) {
      throw new Error('purchase_total_too_large');
    }
  }
  return total;
}

function saoPauloDate(value: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export const partnerPurchaseSchema = z.object({
  supplier_name: z.string().max(160).nullable().optional(),
  purchased_at: z.string().datetime().nullable().optional(),
  payment_method: z.string().max(80).nullable().optional(),
  payment_status: z.enum(['paid_now', 'payable']).nullable().optional(),
  payable_due_date: z.string().date().nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  idempotency_key: z.string().min(8).max(120),
  items: z.array(z.object({
    product_id: z.string().uuid().nullable().optional(),
    item_name: z.string().min(1).max(240),
    tire_size: z.string().max(80).nullable().optional(),
    tire_width_mm: z.number().int().min(1).max(999).nullable().optional(),
    tire_aspect_ratio: z.number().int().min(1).max(999).nullable().optional(),
    tire_rim_diameter: z.number().int().min(1).max(30).nullable().optional(),
    brand: z.string().max(120).nullable().optional(),
    tire_condition: z.enum(['meia_vida', 'novo', 'remold']),
    quantity: z.number().int().positive().max(999_999),
    unit_cost: centMoneySchema,
    sale_price: centMoneySchema.nullable().optional(),
  })).min(1),
}).superRefine((data, ctx) => {
  if (data.payment_status === 'payable' && !data.payable_due_date?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'payable_due_date obrigatorio quando payment_status=payable',
      path: ['payable_due_date'],
    });
  }
  const purchasedAt = data.purchased_at ? new Date(data.purchased_at) : new Date();
  if (purchasedAt.getTime() > Date.now() + 5 * 60_000) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, message: 'partner_purchased_at_future',
      path: ['purchased_at'],
    });
  }
  const purchasedOn = saoPauloDate(purchasedAt);
  if (data.payment_status === 'payable' && data.payable_due_date
      && data.payable_due_date < purchasedOn) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, message: 'partner_payable_due_before_purchase',
      path: ['payable_due_date'],
    });
  }
  try {
    partnerPurchaseTotalCents(data.items);
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : 'purchase_total_invalid',
      path: ['items'],
    });
  }
});
