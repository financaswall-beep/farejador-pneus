import { z } from 'zod';
import { assertPartnerCommercialTerms } from './partner-commercial-terms.js';

const idempotencyKeySchema = z.string().min(8).max(200);

export const settleComissaoSchema = z.object({
  partner_id: z.string().uuid(),
  idempotency_key: idempotencyKeySchema,
  reason: z.string().trim().min(2).max(300),
});

export const settleCommissionRefundSchema = z.object({
  reversal_id: z.string().uuid(),
  idempotency_key: idempotencyKeySchema,
  reason: z.string().trim().min(2).max(500),
});

export const settleMonthlyFeeSchema = z.object({
  fee_id: z.string().uuid(),
  idempotency_key: idempotencyKeySchema,
});

export const partnerIdParamSchema = z.object({ partner_id: z.string().uuid() });

export const partnerTermsSchema = z.object({
  idempotency_key: idempotencyKeySchema,
  commercial_model: z.enum(['commission', 'monthly', 'hybrid']),
  commission_percent: z.number().min(0).max(100).nullable(),
  monthly_fee: z.number().min(0).nullable(),
}).superRefine((body, ctx) => {
  try {
    assertPartnerCommercialTerms(body);
  } catch (error) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: (error as Error).message });
  }
});
