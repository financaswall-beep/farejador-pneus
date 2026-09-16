import { z } from 'zod';
import { tireVehicleTypeSchema } from '../../shared/tire-vehicle-type.js';

export const productParams = z.object({ product_id: z.string().uuid() });
export const priceBody = z.object({
  price_amount: z.number().positive().max(9_999_999.99)
    .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-7,
      'catalog_price_cent_precision'),
  reason: z.string().trim().min(2).max(500),
});
export const createProductBody = z.object({
  vehicle_type: tireVehicleTypeSchema.nullable().optional(),
  measure: z.string().trim().min(1).max(60),
  brand: z.string().trim().min(1).max(60),
  tire_condition: z.enum(['meia_vida', 'novo', 'remold']),
  product_code: z.string().trim().min(2).max(80),
  product_name: z.string().trim().min(2).max(160),
  creation_mode: z.enum(['stock', 'manual']).default('stock'),
  price_amount: z.number().positive().max(9_999_999.99)
    .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-7,
      'catalog_price_cent_precision')
    .nullable().optional(),
  price_reason: z.string().trim().min(2).max(500).nullable().optional(),
  tread_pattern: z.string().trim().max(120).nullable().optional(),
  load_index: z.string().trim().max(20).nullable().optional(),
  speed_rating: z.string().trim().max(20).nullable().optional(),
  position: z.enum(['front', 'rear', 'both']).nullable().optional(),
});
export const tireSpecBody = z.object({
  vehicle_type: tireVehicleTypeSchema.nullable().optional(),
  tread_pattern: z.string().trim().max(120).nullable().optional(),
  load_index: z.string().trim().max(20).nullable().optional(),
  speed_rating: z.string().trim().max(20).nullable().optional(),
  position: z.enum(['front', 'rear', 'both']).nullable().optional(),
  reason: z.string().trim().min(2).max(500),
});
export const vehicleSearchQuery = z.object({ q: z.string().trim().min(2).max(120),
  vehicle_type: tireVehicleTypeSchema.default('motorcycle') });
const fitmentYear = z.number().int().min(1900).max(2100).nullable().optional();
function withValidFitmentRange<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  return schema.superRefine((body, context) => {
    const years = body as { year_start?: number | null; year_end?: number | null };
    if (years.year_start !== null && years.year_start !== undefined
      && years.year_end !== null && years.year_end !== undefined
      && years.year_end < years.year_start) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['year_end'],
        message: 'catalog_compatibility_year_range_invalid',
      });
    }
  });
}
export const compatibilityBody = withValidFitmentRange(z.object({
  vehicle_model_id: z.string().uuid(),
  position: z.enum(['front', 'rear', 'both']),
  is_oem: z.boolean().default(false),
  source: z.enum(['manufacturer', 'manual']).default('manual'),
  confidence_level: z.number().min(0).max(1).default(1),
  year_start: fitmentYear,
  year_end: fitmentYear,
  reason: z.string().trim().min(2).max(500),
}));
export const compatibilityDeleteParams = productParams.extend({
  vehicle_model_id: z.string().uuid(),
  position: z.enum(['front', 'rear', 'both']),
});
export const compatibilityDeleteBody = z.object({ reason: z.string().trim().min(2).max(500) });
export const discoveryBody = withValidFitmentRange(z.object({
  vehicle_model_id: z.string().uuid(),
  position: z.enum(['front', 'rear', 'both']),
  source_url: z.string().trim().url().max(2000),
  source_title: z.string().trim().max(300).nullable().optional(),
  evidence_summary: z.string().trim().min(5).max(2000),
  suggested_is_oem: z.boolean().default(false),
  confidence_level: z.number().min(0).max(1).default(0.8),
  year_start: fitmentYear,
  year_end: fitmentYear,
}));
export const discoveryParams = productParams.extend({ discovery_id: z.string().uuid() });
export const discoveryReviewBody = z.object({
  decision: z.enum(['approve', 'reject']),
  reason: z.string().trim().min(2).max(500),
});
