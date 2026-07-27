import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminAuth, requireAdminOwner } from '../auth.js';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/logger.js';
import { settleMatrizLedgerOpenItem } from './matriz-ledger-settlement.js';
import { getMatrizLedgerStatement } from './matriz-ledger-statement.js';
import {
  settleMatrizExpense, settleWholesaleOrderPayment, settleWholesalePurchasePayment,
} from './queries-financeiro-integridade.js';
import { settleCommissionEntries } from './queries-comissoes-acoes.js';
import { settleCommissionRefund } from './queries-comissoes-estornos.js';
import { settleMatrizPartnerMonthlyFee } from './queries-mensalidades.js';
import { mapWriteError, operatorLabel } from './route-helpers.js';

const paymentDetailsSchema = z.object({
  paid_at: z.string().datetime({ offset: true }).optional(),
  payment_method: z.string().trim().min(2).max(40).optional(),
  cash_account: z.string().trim().min(2).max(80).optional(),
  note: z.string().trim().max(500).optional(),
});

const requiredPaymentDetailsSchema = z.object({
  paid_at: z.string().datetime({ offset: true }),
  payment_method: z.string().trim().min(2).max(40),
  cash_account: z.string().trim().min(2).max(80),
  note: z.string().trim().max(500).optional(),
});

const settleLedgerItemSchema = z.object({
  obligation_id: z.string().uuid().optional(),
  account_code: z.literal('marketing_payable').optional(),
  amount: z.number().positive().max(999_999_999.99).optional(),
  idempotency_key: z.string().trim().min(8).max(200),
}).merge(paymentDetailsSchema).refine((body) =>
  Boolean(body.obligation_id) !== Boolean(body.account_code), {
  message: 'settlement_target_invalid',
});

const settlementModeSchema = z.enum([
  'wholesale_sale', 'retail_sale', 'commission', 'monthly_fee',
  'wholesale_purchase', 'expense', 'commission_refund',
  'central_obligation', 'central_account',
]);

const settleFinanceItemSchema = z.object({
  settlement_mode: settlementModeSchema,
  target_id: z.string().min(1).max(200),
  obligation_id: z.string().uuid().optional(),
  // Compatibilidade com a versão anterior do painel: itens do ledger trazem
  // account_code para exibição e o formulário antigo o reenviava em qualquer
  // baixa. Fora de central_account esse campo não escolhe o alvo e é ignorado.
  account_code: z.string().trim().min(1).max(80).optional(),
  amount: z.number().positive().max(999_999_999.99).optional(),
  idempotency_key: z.string().trim().min(8).max(200),
}).merge(requiredPaymentDetailsSchema).superRefine((body, ctx) => {
  const centralObligation = ['retail_sale', 'central_obligation']
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
  const acceptsPartial = ['retail_sale', 'central_obligation', 'central_account']
    .includes(body.settlement_mode);
  if (!acceptsPartial && body.amount !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ['amount'],
      message: 'partial_settlement_not_supported',
    });
  }
});

const statementQuerySchema = z.object({
  mes: z.string().regex(/^\d{4}-\d{2}$/),
  base: z.enum(['competencia', 'caixa']).default('competencia'),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

function commonDetails(data: z.infer<typeof paymentDetailsSchema>) {
  return {
    paid_at: data.paid_at, payment_method: data.payment_method,
    cash_account: data.cash_account, note: data.note,
  };
}

export async function registerPainelFinanceiroLedger(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.get('/admin/api/matriz/financeiro/ledger/statement', {
    preHandler: requireAdminAuth,
  }, async (request, reply) => {
    if (!env.MATRIZ_CENTRAL_LEDGER || !env.MATRIZ_CENTRAL_LEDGER_READ) {
      return reply.status(409).send({ error: 'central_ledger_read_disabled' });
    }
    const parsed = statementQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: parsed.error.issues[0]?.message ?? 'invalid_query',
      });
    }
    return reply.status(200).send(await getMatrizLedgerStatement({
      period: parsed.data.mes, basis: parsed.data.base,
      limit: parsed.data.limit, offset: parsed.data.offset,
    }));
  });

  fastify.post('/admin/api/matriz/financeiro/ledger/settle', {
    preHandler: requireAdminOwner,
  }, async (request, reply) => {
    if (!env.MATRIZ_CENTRAL_LEDGER || !env.MATRIZ_CENTRAL_LEDGER_READ) {
      return reply.status(409).send({ error: 'central_ledger_read_disabled' });
    }
    const parsed = settleLedgerItemSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: parsed.error.issues[0]?.message ?? 'invalid_body',
      });
    }
    try {
      const target = parsed.data.obligation_id
        ? { obligation_id: parsed.data.obligation_id }
        : { account_code: parsed.data.account_code! };
      const result = await settleMatrizLedgerOpenItem({
        ...target, amount: parsed.data.amount,
        payment_method: parsed.data.payment_method,
        paid_at: parsed.data.paid_at,
        cash_account: parsed.data.cash_account,
        note: parsed.data.note,
        idempotency_key: parsed.data.idempotency_key,
        actor_label: operatorLabel(request),
      });
      return reply.status(200).send({ settled: true, ...result });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'internal_server_error';
      if (['settlement_amount_invalid', 'retail_payment_method_required',
        'central_obligation_not_actionable'].includes(code)) {
        return reply.status(400).send({ error: code });
      }
      if (['settlement_exceeds_balance', 'central_obligation_not_open',
        'retail_receivable_not_open'].includes(code)) {
        return reply.status(409).send({ error: code });
      }
      const mapped = mapWriteError(error);
      logger.error({ error, status: mapped.status }, 'central ledger settlement failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // Porta única da tela Financeiro. As tabelas operacionais continuam sendo
  // atualizadas por seus serviços de domínio, mas a UI não precisa conhecer
  // endpoints de Compras, Rede ou Colaboradores para registrar uma baixa.
  fastify.post('/admin/api/matriz/financeiro/settle', {
    preHandler: requireAdminOwner,
  }, async (request, reply) => {
    const parsed = settleFinanceItemSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: parsed.error.issues[0]?.message ?? 'invalid_body',
      });
    }
    const data = parsed.data;
    const actor = operatorLabel(request);
    const details = commonDetails(data);
    try {
      let result: unknown;
      if (['retail_sale', 'central_obligation', 'central_account']
        .includes(data.settlement_mode)) {
        if (!env.MATRIZ_CENTRAL_LEDGER || !env.MATRIZ_CENTRAL_LEDGER_READ) {
          return reply.status(409).send({ error: 'central_ledger_read_disabled' });
        }
        const target = data.settlement_mode === 'central_account'
          ? { account_code: data.account_code! as 'marketing_payable' }
          : { obligation_id: data.obligation_id! };
        result = await settleMatrizLedgerOpenItem({
          ...target, amount: data.amount, ...details,
          idempotency_key: data.idempotency_key, actor_label: actor,
        });
      } else if (data.settlement_mode === 'wholesale_sale') {
        result = await settleWholesaleOrderPayment(
          data.target_id, env.FAREJADOR_ENV, undefined,
          { ...details, idempotency_key: data.idempotency_key, actor_label: actor },
        );
      } else if (data.settlement_mode === 'wholesale_purchase') {
        result = await settleWholesalePurchasePayment(
          data.target_id, env.FAREJADOR_ENV, undefined,
          { ...details, idempotency_key: data.idempotency_key, actor_label: actor },
        );
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
      return reply.status(200).send({ settled: true, result });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'internal_server_error';
      if (['settlement_amount_invalid', 'retail_payment_method_required',
        'central_obligation_not_actionable'].includes(code)) {
        return reply.status(400).send({ error: code });
      }
      if (['settlement_exceeds_balance', 'central_obligation_not_open',
        'retail_receivable_not_open', 'payroll_payment_conflict',
        'commission_refund_not_pending'].includes(code)) {
        return reply.status(409).send({ error: code });
      }
      if (['receivable_not_found', 'payable_not_found', 'expense_not_found',
        'nothing_open', 'monthly_fee_not_found',
        'commission_refund_not_found'].includes(code)) {
        return reply.status(404).send({ error: code });
      }
      const mapped = mapWriteError(error);
      logger.error({ error, status: mapped.status }, 'finance settlement facade failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });
}
