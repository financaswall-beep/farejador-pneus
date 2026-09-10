import { z } from 'zod';
import { reportDate, validReportRange } from './report-period.js';

export const purchaseReportQuery = z.object({
  from: reportDate, to: reportDate,
  mode: z.enum(['month', 'week', 'custom']).default('month'),
  compare: z.enum(['true', 'false']).default('true'),
  supplier: z.union([z.string().uuid(), z.literal('')]).default(''),
  brand: z.string().trim().max(60).default(''),
  condition: z.enum(['', 'novo', 'meia_vida', 'remold', 'unknown']).default(''),
  receipt: z.enum(['all', 'received', 'pending']).default('all'),
  measure: z.string().trim().max(200).default(''),
  exact: z.enum(['true', 'false']).default('false'),
  offset: z.coerce.number().int().min(0).max(50000).default(0),
  view: z.enum(['overview', 'products', 'suppliers', 'purchases']).default('overview'),
}).strict().refine(validReportRange);
export type PurchaseReportFilter = z.infer<typeof purchaseReportQuery>;
