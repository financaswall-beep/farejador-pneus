import { z } from 'zod';
import { reportDate,validReportRange } from './report-period.js';
export const partnerReportQuery=z.object({
  from:reportDate,to:reportDate,mode:z.enum(['month','week','custom']).default('month'),compare:z.enum(['true','false']).default('true'),
  city:z.string().trim().max(80).default(''),search:z.string().trim().max(120).default(''),
  activity:z.enum(['all','selling','idle']).default('all'),status:z.enum(['all','active','suspended','credentialing','archived']).default('all'),
  sort:z.enum(['sales','orders','commission','open','name']).default('sales'),partner:z.union([z.string().uuid(),z.literal('')]).default(''),
  channel:z.enum(['all','farejador','direct','other']).default('all'),commission_scope:z.enum(['generated','received','reversed','open','refund']).default('generated'),
  view:z.enum(['overview','partners','sales','commissions']).default('overview'),
}).strict().refine(validReportRange);
export type PartnerReportFilter=z.infer<typeof partnerReportQuery>;
export class PartnerReportLimitError extends Error {}
