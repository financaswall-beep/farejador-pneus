import { z } from 'zod';
import { reportDate, validReportRange } from './report-period.js';

export const priceReportQuerySchema = z.object({
  period: z.enum(['30d', '90d', 'year', 'all']).default('90d'),
  supplier_id: z.string().uuid().optional(),
  search: z.string().trim().max(80).optional(),
  from: reportDate.optional(), to: reportDate.optional(),
}).strict().refine(value => !value.from && !value.to
  || !!value.from && !!value.to && validReportRange({ from: value.from, to: value.to }), {
  message: 'invalid_date_range',
});
