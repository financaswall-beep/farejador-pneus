import { z } from 'zod';

/** Shared by the web panel and the operation app. */
export const purchaseReportQuerySchema = z.object({
  period: z.enum(['30d', '90d', 'year', 'all']).default('30d'),
  status: z.enum(['all', 'pending', 'confirmed', 'cancelled']).default('all'),
  payment: z.enum(['all', 'paid', 'pending']).default('all'),
  supplier_id: z.string().uuid().optional(),
  search: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  page_size: z.coerce.number().int().min(4).max(100).default(10),
});
