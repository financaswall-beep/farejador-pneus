import { z } from 'zod';
import { businessDateSaoPaulo, isNotFutureBusinessDate } from '../../shared/business-time.js';

const idempotencyKeySchema = z.string().min(8).max(200);
const nonFutureBusinessDatetime = (message: string) => z.string().datetime({ offset: true }).refine(isNotFutureBusinessDate, message);

// DESPESAS da matriz (0120): lançar (à vista × a pagar), quitar e remover (soft).
export const createMatrizExpenseSchema = z.object({
  group_id: z.string().uuid().nullable().optional(),
  receipt_id: z.string().uuid().optional(),
  receipt_confirmed: z.boolean().optional(),
  // Categoria ativa é validada na transação; aqui validamos o formato.
  category: z.string().regex(/^[a-z0-9_]{2,40}$/),
  description: z.string().max(300).nullable().optional(),
  amount: z.number().positive(),
  payment_status: z.enum(['paid', 'pending']).optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  paid_at: nonFutureBusinessDatetime('paid_at_future').nullable().optional(),
  occurred_at: nonFutureBusinessDatetime('occurred_at_future').nullable().optional(),
  document_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  competence_month: z.string().regex(/^\d{4}-\d{2}-01$/).nullable().optional(),
  idempotency_key: idempotencyKeySchema,
}).superRefine((body, ctx) => {
  if (body.receipt_id && (body.receipt_confirmed !== true || !body.payment_status)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['receipt_confirmed'], message: 'expense_receipt_confirmation_required' });
  }
  if (body.payment_status === 'pending' && !body.due_date) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['due_date'], message: 'due_date_required' });
  }
  const today = businessDateSaoPaulo(new Date());
  if (body.document_date && body.document_date > today) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['document_date'], message: 'document_date_future' });
  }
  if (body.competence_month && body.competence_month > `${today.slice(0, 7)}-01`) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['competence_month'], message: 'competence_month_future' });
  }
});

export const matrizExpenseIdSchema = z.object({
  id: z.string().uuid(),
  paid_at: nonFutureBusinessDatetime('paid_at_future').optional(),
  payment_method: z.string().trim().min(2).max(40).nullable().optional(),
  cash_account: z.string().trim().min(2).max(80).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  idempotency_key: idempotencyKeySchema,
});

export const matrizExpenseRemoveSchema = matrizExpenseIdSchema.extend({
  reason: z.string().trim().min(2).max(300),
});

// 0130: modalidades de despesa cadastráveis + filtro de período da lista.
export const matrizExpenseCategoryCreateSchema = z.object({
  label: z.string().trim().min(2).max(40),
});
export const matrizExpenseCategoryArchiveSchema = z.object({
  slug: z.string().regex(/^[a-z0-9_]{2,40}$/),
});
export const matrizExpensesQuerySchema = z.object({
  group_id: z.string().uuid().optional(),
  mes: z.string().regex(/^\d{4}-\d{2}$/).optional(),       // competência (occurred_at, fuso SP)
  categoria: z.string().regex(/^[a-z0-9_]{2,40}$/).optional(),
});
