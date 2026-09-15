import { z } from 'zod';
const amount = z.number().finite().min(0).max(99_999_999.99).multipleOf(0.01);
export const lotSaleSchema = z.object({
  customer_id: z.string().uuid().optional(), partner_id: z.string().uuid().optional(),
  new_customer: z.object({ name: z.string().trim().min(2).max(160), phone: z.string().trim().max(32).optional() }).optional(),
  description: z.string().trim().min(2).max(200),
  sold_on: z.string().date(), amount: amount.refine(value => value > 0), discount: amount.default(0),
  expected_cost: amount, payment_status: z.enum(['paid','pending']),
  payment_method: z.enum(['Pix','Dinheiro','Cartão']).optional(), due_date: z.string().date().optional(),
  notes: z.string().trim().max(1000).default(''), idempotency_key: z.string().uuid(),
  allocations: z.array(z.object({ lot_id: z.string().uuid(), quantity: z.number().int().positive().max(100000) })).min(1).max(100),
}).strict().superRefine((data, ctx) => {
  const error = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if ([data.customer_id,data.partner_id,data.new_customer].filter(Boolean).length !== 1) error('buyer_required');
  if (data.discount >= data.amount) error('lot_sale_discount_invalid');
  if (new Set(data.allocations.map(row => row.lot_id)).size !== data.allocations.length) error('lot_sale_duplicate_lot');
  if (data.allocations.reduce((total,row) => total+row.quantity,0) > 100000) error('lot_sale_quantity_limit');
  if (data.payment_status === 'paid' && !data.payment_method) error('payment_method_required');
  if (data.payment_status === 'pending' && (!data.due_date || data.due_date < data.sold_on)) error('due_date_invalid');
});
export type LotSaleInput = z.infer<typeof lotSaleSchema>;

// Divide cent amounts without binary floating point. The last allocation keeps
// the remainder so partial sales never lose money from the original lot.
export function prorateLotCents(cents: number, quantity: number, totalQuantity: number): number {
  if (!Number.isSafeInteger(cents) || cents < 0 || !Number.isSafeInteger(quantity)
      || quantity < 0 || quantity > totalQuantity || !Number.isSafeInteger(totalQuantity) || totalQuantity <= 0) {
    throw new Error('lot_sale_allocation_invalid');
  }
  return Number((BigInt(cents)*BigInt(quantity)*2n+BigInt(totalQuantity))/(BigInt(totalQuantity)*2n));
}
