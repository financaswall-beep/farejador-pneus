import {z} from 'zod';
import {isNotFutureBusinessDate} from '../../shared/business-time.js';

const text=(max:number)=>z.string().trim().min(3).max(max).refine(v=>!/[\x00-\x1f\x7f]/.test(v));
const date=z.string().datetime({offset:true}).refine(isNotFutureBusinessDate,'future_date');
const key=z.string().uuid();
export const manualEntrySchema=z.object({
  kind:z.enum(['income','owner_contribution']),
  category:z.enum(['servicos','alugueis','outras_receitas']).optional(),
  description:text(400),amount:z.number().positive().max(999_999_999.99)
    .refine(v=>Math.abs(v*100-Math.round(v*100))<1e-7,'amount_cent_precision'),
  occurred_at:date,payment_method:z.enum(['dinheiro','pix','transferencia','cartao']),
  cash_account:z.string().trim().min(2).max(80).refine(v=>!/[\x00-\x1f\x7f]/.test(v)),
  idempotency_key:key,
}).strict().refine(v=>v.kind!=='income'||!!v.category,{path:['category'],message:'income_category_required'});
export const reverseManualEntrySchema=z.object({reason:text(400),occurred_at:date,idempotency_key:key}).strict();
export type ManualFinanceEntry=z.infer<typeof manualEntrySchema>;
export type ManualFinanceCorrection=z.infer<typeof reverseManualEntrySchema>;
