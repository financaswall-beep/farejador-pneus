import { z } from 'zod';
import { reportDate,validReportRange,reportComparison,reportAddDays } from './report-period.js';
export const demandReportQuery=z.object({
  from:reportDate,to:reportDate,mode:z.enum(['month','week','custom']).default('month'),compare:z.enum(['true','false']).default('true'),
  city:z.string().trim().max(120).default(''),citySearch:z.string().trim().max(120).default(''),
  measure:z.string().trim().max(80).default(''),search:z.string().trim().max(80).default(''),
  view:z.enum(['overview','cities','measures','evolution']).default('overview'),
  metric:z.enum(['conversations','orders','deliveries','shortages']).default('conversations'),
  grain:z.enum(['day','week']).default('day'),sort:z.enum(['conversations','orders','shortages','conversion','name']).default('conversations'),
}).strict().refine(validReportRange);
export type DemandReportFilter=z.infer<typeof demandReportQuery>;
export class DemandReportLimitError extends Error {}
export function demandComparison(f:DemandReportFilter){
  const previous=reportComparison(f);if(!previous)return null;
  const span=Date.parse(f.to)-Date.parse(f.from);
  // Month-to-date uses the same dates of the prior month when it has enough days.
  // Otherwise compare with the immediately preceding interval of equal length.
  return Date.parse(previous.to)-Date.parse(previous.from)===span?previous:
    {from:reportAddDays(f.from,-span/86400000-1),to:reportAddDays(f.from,-1)};
}
