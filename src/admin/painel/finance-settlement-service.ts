import { z } from 'zod';
import { env } from '../../shared/config/env.js';
import { isNotFutureBusinessDate } from '../../shared/business-time.js';
import { settleMatrizLedgerOpenItem } from './matriz-ledger-settlement.js';
import { settleMatrizExpense } from './queries-financeiro-integridade.js';
import { settleCommissionEntries } from './queries-comissoes-acoes.js';
import { settleCommissionRefund } from './queries-comissoes-estornos.js';
import { settleMatrizPartnerMonthlyFee } from './queries-mensalidades.js';

const paidAtSchema = z.string().datetime({ offset: true })
  .refine(isNotFutureBusinessDate, 'paid_at_future');

const requiredPaymentDetailsSchema = z.object({
  paid_at: paidAtSchema,
  payment_method: z.string().trim().min(2).max(40),
  cash_account: z.string().trim().min(2).max(80),
  note: z.string().trim().max(500).optional(),
});

const settlementAmountSchema = z.number().positive().max(999_999_999.99)
  .refine(
    (value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-7,
    'settlement_amount_cent_precision',
  );

const settlementModeSchema = z.enum([
  'wholesale_sale', 'retail_sale', 'commission', 'monthly_fee',
  'wholesale_purchase', 'expense', 'commission_refund',
  'central_obligation', 'central_account',
]);

export const settleFinanceItemSchema = z.object({
  settlement_mode: settlementModeSchema,
  target_id: z.string().min(1).max(200),
  obligation_id: z.string().uuid().optional(),
  // Compatibilidade com a versão anterior do painel: itens do ledger trazem
  // account_code para exibição e o formulário antigo o reenviava em qualquer
  // baixa. Fora de central_account esse campo não escolhe o alvo e é ignorado.
  account_code: z.string().trim().min(1).max(80).optional(),
  amount: settlementAmountSchema.optional(),
  idempotency_key: z.string().trim().min(8).max(200),
}).merge(requiredPaymentDetailsSchema).superRefine((body, ctx) => {
  const centralObligation = ['retail_sale', 'wholesale_sale',
    'wholesale_purchase', 'central_obligation']
    .includes(body.settlement_mode);
  if (centralObligation && !body.obligation_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ['obligation_id'],
      message: 'settlement_target_invalid',
    });
  }
  if (body.settlement_mode === 'central_account'
    && body.account_code !== 'marketing_payable') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ['account_code'],
      message: 'settlement_target_invalid',
    });
  }
  const acceptsPartial = ['retail_sale', 'wholesale_sale', 'wholesale_purchase',
    'central_obligation', 'central_account']
    .includes(body.settlement_mode);
  if (!acceptsPartial && body.amount !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ['amount'],
      message: 'partial_settlement_not_supported',
    });
  }
});

/** Porta compartilhada pelo Financeiro web e app; mantém os serviços e a idempotência de cada domínio. */
export async function settleFinanceItem(data: z.infer<typeof settleFinanceItemSchema>, actor: string) {
  const details = { paid_at: data.paid_at, payment_method: data.payment_method, cash_account: data.cash_account, note: data.note };
  let result: unknown;
  if (['retail_sale', 'wholesale_sale', 'wholesale_purchase',
    'central_obligation', 'central_account']
    .includes(data.settlement_mode)) {
    if (!env.MATRIZ_CENTRAL_LEDGER || !env.MATRIZ_CENTRAL_LEDGER_READ) {
      throw new Error('central_ledger_read_disabled');
    }
    const target = data.settlement_mode === 'central_account'
      ? { account_code: data.account_code! as 'marketing_payable' }
      : { obligation_id: data.obligation_id! };
    result = await settleMatrizLedgerOpenItem({
      ...target, amount: data.amount, ...details,
      idempotency_key: data.idempotency_key, actor_label: actor,
    });
  } else if (data.settlement_mode === 'expense') {
    result = await settleMatrizExpense(
      data.target_id, env.FAREJADOR_ENV, undefined,
      { ...details, idempotency_key: data.idempotency_key, actor_label: actor },
    );
  } else if (data.settlement_mode === 'commission') {
    result = await settleCommissionEntries({
      partner_id: data.target_id, settled_by: actor,
      idempotency_key: data.idempotency_key,
      reason: data.note || 'Recebimento confirmado no Financeiro',
      settled_at: data.paid_at, payment_method: data.payment_method,
      cash_account: data.cash_account, note: data.note,
    });
  } else if (data.settlement_mode === 'monthly_fee') {
    result = await settleMatrizPartnerMonthlyFee({
      fee_id: data.target_id, actor_label: actor,
      idempotency_key: data.idempotency_key,
      settled_at: data.paid_at, payment_method: data.payment_method,
      cash_account: data.cash_account, note: data.note,
    });
  } else {
    result = await settleCommissionRefund({
      reversal_id: data.target_id, actor_label: actor,
      idempotency_key: data.idempotency_key,
      reason: data.note || 'Devolução confirmada no Financeiro',
      refunded_at: data.paid_at, payment_method: data.payment_method,
      cash_account: data.cash_account, note: data.note,
    });
  }
  return result;
}
