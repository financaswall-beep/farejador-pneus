import { z } from 'zod';
import { reportDate,validReportRange } from './report-period.js';
export const shortageReportQuery=z.object({
  from:reportDate,to:reportDate,mode:z.enum(['month','week','custom']).default('month'),
  store:z.union([z.literal(''),z.literal('matriz'),z.string().uuid()]).default(''),
  measure:z.string().trim().max(80).default(''),search:z.string().trim().max(80).default(''),
  view:z.enum(['overview','measures','consultations','potential']).default('overview'),
}).strict().refine(validReportRange);
export type ShortageReportFilter=z.infer<typeof shortageReportQuery>;
export class ShortageReportLimitError extends Error {}
