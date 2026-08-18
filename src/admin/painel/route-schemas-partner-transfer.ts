import { z } from 'zod';
import { hasCentPrecision } from './sales-money.js';

const idempotencyKey = z.string().trim().min(8).max(200);

export const partnerArrivalAdjustmentSchema = z.object({
  items: z.array(z.object({
    order_item_id: z.string().uuid(),
    accepted_quantity: z.number().int().min(0).max(100000),
  })).min(1).max(50),
  cargo_additions: z.array(z.object({
    cargo_lot_id: z.string().uuid(),
    quantity: z.number().int().positive().max(100000),
    unit_price: z.number().min(0).max(9999999.99)
      .refine(hasCentPrecision, 'unit_price_cent_precision'),
  })).max(50).optional(),
  idempotency_key: idempotencyKey,
}).superRefine((body, ctx) => {
  const itemIds = body.items.map((item) => item.order_item_id);
  if (new Set(itemIds).size !== itemIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['items'], message: 'duplicate_order_item' });
  }
  const cargoIds = (body.cargo_additions ?? []).map((item) => item.cargo_lot_id);
  if (new Set(cargoIds).size !== cargoIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cargo_additions'], message: 'duplicate_cargo_lot' });
  }
});

export const partnerCargoReturnSchema = z.object({
  reason: z.string().trim().min(2).max(300),
  idempotency_key: idempotencyKey,
});

export const partnerTransferOrderParamsSchema = z.object({
  order_id: z.string().uuid(),
});

export const partnerCargoParamsSchema = z.object({
  cargo_lot_id: z.string().uuid(),
});
