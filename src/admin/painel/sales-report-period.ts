import { vehicleReportFilterSchema } from '../../shared/tire-vehicle-type.js';
import { z } from 'zod';
import { reportDate as date, validReportRange } from './report-period.js';
export { reportDay, reportAddDays, reportComparison as salesReportComparison } from './report-period.js';
export const salesReportQuery = z.object({
  vehicle_type: vehicleReportFilterSchema.default('all'),
  from: date, to: date,
  mode: z.enum(['month', 'week', 'custom']).default('month'),
  compare: z.enum(['true', 'false']).default('true'),
  channel: z.enum(['all', 'varejo', 'atacado']).default('all'),
  brand: z.string().trim().max(60).default(''),
  condition: z.enum(['', 'novo', 'meia_vida', 'remold', 'unknown']).default(''),
  measure: z.string().trim().max(200).default(''),
  exact: z.enum(['true', 'false']).default('false'),
  offset: z.coerce.number().int().min(0).max(50000).default(0),
}).strict().refine(validReportRange);
export type SalesReportFilter = z.infer<typeof salesReportQuery>;
