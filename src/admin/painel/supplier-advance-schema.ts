import { z } from 'zod';
import { isNotFutureBusinessDate } from '../../shared/business-time.js';
const uuid=z.string().uuid();
const amount=z.number().positive().max(999999999.99).refine(v=>Math.abs(v*100-Math.round(v*100))<1e-6,'amount_cent_precision');
const base={supplier_id:uuid,amount,occurred_at:z.string().datetime({offset:true}).refine(isNotFutureBusinessDate),
  reason:z.string().trim().min(3).max(300),idempotency_key:uuid};
const cash={payment_method:z.enum(['dinheiro','pix','transferencia']),cash_account:z.string().trim().min(2).max(80)};
export const advanceIssueSchema=z.object({...base,...cash,action:z.literal('issue'),
  bank_reference:z.string().trim().min(5).max(100).optional(),distinct_from:z.array(uuid).max(30).optional()}).strict();
export const advanceApplySchema=z.object({...base,action:z.literal('apply'),advance_id:uuid,purchase_id:uuid,installment:z.number().int().positive().optional()}).strict();
export const advanceRestoreSchema=z.object({...base,action:z.literal('restore'),application_id:uuid}).strict();
export const advanceRefundSchema=z.object({...base,...cash,action:z.literal('refund'),advance_id:uuid}).strict();
export const advanceVoidSchema=z.object({...base,action:z.literal('void'),advance_id:uuid}).strict();
export const advanceCommandSchema=z.discriminatedUnion('action',[advanceIssueSchema,advanceApplySchema,advanceRestoreSchema,advanceRefundSchema,advanceVoidSchema]);
export type AdvanceCommand=z.infer<typeof advanceCommandSchema>;
