import { z } from 'zod';
import { hasCentPrecision } from '../painel/sales-money.js';

const positiveMoney = z.number().positive().max(99_999_999.99)
  .refine(hasCentPrecision, 'unit_price_cent_precision');

export const createCaixaSaleSchema = z.object({
  customer_name: z.string().trim().min(1).max(200).nullable().optional(),
  customer_phone: z.string().trim().min(1).max(40).nullable().optional(),
  payment_method: z.enum(['pix', 'cartao', 'dinheiro']),
  idempotency_key: z.string().trim().min(8).max(120),
  items: z.array(z.object({
    product_id: z.string().uuid(),
    quantity: z.number().int().positive().max(50),
    unit_price: positiveMoney,
    reference_unit_price: positiveMoney.optional(),
  })).min(1).max(30),
}).refine((data) => data.items.reduce((sum, item) => sum + item.quantity, 0) <= 100, {
  message: 'sale_quantity_limit',
  path: ['items'],
});
