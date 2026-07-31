import { z } from 'zod';

const idempotencyKeySchema = z.string().min(8).max(200);
const tireConditionSchema = z.enum(['meia_vida', 'novo', 'remold']);
const variantSchema = {
  measure: z.string().trim().min(1).max(60),
  brand: z.string().trim().min(1, 'brand_required').max(60),
  tire_condition: tireConditionSchema,
};

export const setWholesaleStockSchema = z.object({
  ...variantSchema,
  quantity_on_hand: z.number().int().min(0).max(1_000_000),
  unit_cost: z.number().min(0).max(9_999_999.99).optional(),
  min_quantity: z.number().int().min(0).max(1_000_000).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  reason: z.string().trim().min(2).max(300).optional(),
});

export const removeWholesaleStockSchema = z.object(variantSchema);

export const transferWholesaleStockConditionSchema = z.object({
  measure: variantSchema.measure,
  brand: variantSchema.brand,
  from_condition: tireConditionSchema,
  to_condition: tireConditionSchema,
  quantity: z.number().int().positive().max(1_000_000),
  reason: z.string().trim().min(2).max(300),
  idempotency_key: idempotencyKeySchema,
}).refine(
  (data) => data.from_condition !== data.to_condition,
  { message: 'condition_transfer_same', path: ['to_condition'] },
);

export const entryWholesaleStockSchema = z.object({
  ...variantSchema,
  quantity_in: z.number().int().positive().max(1_000_000),
  unit_cost: z.number().min(0).max(9_999_999.99),
  entry_nature: z.enum(['inventory_found', 'owner_contribution', 'opening_balance', 'other']),
  reason: z.string().trim().min(2).max(300),
  idempotency_key: idempotencyKeySchema,
});

export const baixaWholesaleStockSchema = z.object({
  ...variantSchema,
  quantity: z.number().int('quantidade_inteira').positive().max(1_000_000),
  nature: z.enum(['breakage', 'loss', 'internal_use', 'other']),
  reason: z.string().min(2).max(300),
  idempotency_key: idempotencyKeySchema,
});

export const physicalStockCountSchema = z.object({
  rows: z.array(z.object({
    ...variantSchema,
    counted_quantity: z.number().int().min(0).max(1_000_000),
  })).min(1).max(500),
  reason: z.string().trim().min(2).max(300),
  idempotency_key: idempotencyKeySchema,
});
