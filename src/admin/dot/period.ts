import { z } from 'zod';
import { businessDateSaoPaulo } from '../../shared/business-time.js';
import { reportAddDays } from '../painel/report-period.js';
import { overviewPeriod } from '../painel/matriz-overview.js';

export const periodInput = z.object({periodo:z.enum(['hoje','7dias','30dias','mes']).default('hoje'),
  mes:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional()}).strict();
export function dotPeriod(input:z.infer<typeof periodInput>,now=new Date()) {
  const today=businessDateSaoPaulo(now),month=input.mes??today.slice(0,7);
  if(input.mes && input.periodo!=='mes')throw new Error('month_requires_month_period');
  if(input.periodo==='30dias')return {from:reportAddDays(today,-29),to:today,month:today.slice(0,7)};
  return overviewPeriod(input.periodo==='hoje'?'today':input.periodo==='7dias'?'7d':'month',month,now);
}
