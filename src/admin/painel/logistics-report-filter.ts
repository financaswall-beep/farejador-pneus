import { z } from 'zod';
import { reportDate, validReportRange } from './report-period.js';

export const logisticsReportQuery = z.object({
  from: reportDate, to: reportDate,
  mode: z.enum(['month','week','custom']).default('month'),
  courier: z.string().trim().max(200).default(''),
  status: z.enum(['all','open','closed','occurrences','financial_pending']).default('all'),
  search: z.string().trim().max(120).default(''),
  trip: z.union([z.string().uuid(),z.literal('')]).default(''),
  delivery: z.enum(['all','delivered','failed','cancelled','pending']).default('all'),
  receipt: z.enum(['all','linked','pending','rejected','legacy']).default('all'),
  view: z.enum(['overview','trips','deliveries','costs']).default('overview'),
}).strict().refine(validReportRange);
export type LogisticsReportFilter = z.infer<typeof logisticsReportQuery>;
export class LogisticsReportLimitError extends Error {}
