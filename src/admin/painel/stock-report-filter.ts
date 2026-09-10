import { z } from 'zod';

export const stockReportQuery = z.object({
  days: z.enum(['30','60','90']).default('30'),
  condition: z.enum(['','novo','meia_vida','remold']).default(''),
  status: z.enum(['all','replenish','zero','incoming','healthy','no_sales','no_minimum']).default('all'),
  measure: z.string().trim().max(200).default(''),
  exact: z.enum(['true','false']).default('false'),
  view: z.enum(['overview','products','replenishment','movements']).default('overview'),
  movement: z.enum(['all','in','out','unchanged']).default('all'),
  source: z.enum(['all','purchase','sale','return','adjustment','other']).default('all'),
  offset: z.coerce.number().int().min(0).max(50000).default(0),
}).strict();
export type StockReportFilter = z.infer<typeof stockReportQuery>;
export class StockReportLimitError extends Error {}
