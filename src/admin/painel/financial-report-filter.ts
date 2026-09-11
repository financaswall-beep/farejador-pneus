import { z } from 'zod';
import { reportDate, validReportRange } from './report-period.js';

export const financialOrigins=['all','atacado','varejo','compras','despesas','comissao','mensalidades','marketing','estoque','financeiro','outros'] as const;
export const financialReportQuery=z.object({
  from:reportDate,to:reportDate,mode:z.enum(['month','week','custom']).default('month'),
  origin:z.enum(financialOrigins).default('all'),search:z.string().trim().max(120).default(''),
  view:z.enum(['overview','result','cash','titles']).default('overview'),
  flow:z.enum(['realized','projected']).default('realized'),horizon:z.coerce.number().int().refine(n=>[7,30,90].includes(n)).default(30),
  direction:z.enum(['all','in','out']).default('all'),cash_day:z.union([reportDate,z.literal('')]).default(''),
  result_kind:z.enum(['all','revenue','cost','expense','adjustment']).default('all'),
  title_side:z.enum(['all','receivable','payable']).default('all'),
  due:z.enum(['all','overdue','today','next7','next30','undated']).default('all'),
}).strict().refine(validReportRange).refine(f=>!f.cash_day||(f.cash_day>=f.from&&f.cash_day<=f.to));
export type FinancialReportFilter=z.infer<typeof financialReportQuery>;
export class FinancialReportLimitError extends Error {}
