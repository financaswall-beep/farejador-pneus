import { settleFinanceItem, settleFinanceItemSchema } from './finance-settlement-service.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminAuth, requireAdminOwner } from '../auth.js';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/logger.js';
import { settleMatrizLedgerOpenItem } from './matriz-ledger-settlement.js';
import { getMatrizLedgerStatement } from './matriz-ledger-statement.js';
import { writeOffMatrizCredit } from './matriz-ledger-writeoff.js';
import { mapWriteError, operatorLabel } from './route-helpers.js';
import { isNotFutureBusinessDate } from '../../shared/business-time.js';

const paidAtSchema = z.string().datetime({ offset: true })
  .refine(isNotFutureBusinessDate, 'paid_at_future');

const paymentDetailsSchema = z.object({
  paid_at: paidAtSchema.optional(),
  payment_method: z.string().trim().min(2).max(40).optional(),
  cash_account: z.string().trim().min(2).max(80).optional(),
  note: z.string().trim().max(500).optional(),
});

const settlementAmountSchema = z.number().positive().max(999_999_999.99)
  .refine(
    (value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-7,
    'settlement_amount_cent_precision',
  );

const settleLedgerItemSchema = z.object({
  obligation_id: z.string().uuid().optional(),
  account_code: z.literal('marketing_payable').optional(),
  amount: settlementAmountSchema.optional(),
  idempotency_key: z.string().trim().min(8).max(200),
}).merge(paymentDetailsSchema).refine((body) =>
  Boolean(body.obligation_id) !== Boolean(body.account_code), {
  message: 'settlement_target_invalid',
});

const writeOffCreditSchema = z.object({
  obligation_id: z.string().uuid(),
  amount: settlementAmountSchema.optional(),
  occurred_at: paidAtSchema.optional(),
  reason: z.string().trim().min(3).max(500),
  idempotency_key: z.string().trim().min(8).max(200),
});

const statementQuerySchema = z.object({
  mes: z.string().regex(/^\d{4}-\d{2}$/),
  base: z.enum(['competencia', 'caixa']).default('competencia'),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

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
      if (['settlement_amount_invalid', 'settlement_amount_cent_precision',
        'retail_payment_method_required',
        'central_obligation_not_actionable'].includes(code)) {
        return reply.status(400).send({ error: code });
      }
      if (code === 'central_ledger_read_disabled') return reply.status(409).send({ error: code });
      if (['settlement_exceeds_balance', 'central_obligation_not_open',
        'retail_receivable_not_open'].includes(code)) {
        return reply.status(409).send({ error: code });
      }
      const mapped = mapWriteError(error);
      logger.error({ error, status: mapped.status }, 'central ledger settlement failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  fastify.post('/admin/api/matriz/financeiro/ledger/write-off', {
    preHandler: requireAdminOwner,
  }, async (request, reply) => {
    const parsed = writeOffCreditSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({
      error: parsed.error.issues[0]?.message ?? 'invalid_body',
    });
    try {
      const result = await writeOffMatrizCredit({
        ...parsed.data, actor_label: operatorLabel(request),
      });
      return reply.status(200).send({ written_off: true, ...result });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'internal_server_error';
      if (['credit_writeoff_amount_invalid', 'credit_writeoff_not_actionable']
        .includes(code)) return reply.status(400).send({ error: code });
      if (['credit_writeoff_not_open', 'credit_writeoff_exceeds_balance']
        .includes(code)) return reply.status(409).send({ error: code });
      const mapped = mapWriteError(error);
      logger.error({ error, status: mapped.status }, 'credit write-off failed');
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
    try {
      const result = await settleFinanceItem(data, actor);
      return reply.status(200).send({ settled: true, result });
    } catch (error) {
      const code = error instanceof Error ? error.message : 'internal_server_error';
      if (['settlement_amount_invalid', 'settlement_amount_cent_precision',
        'retail_payment_method_required',
        'central_obligation_not_actionable'].includes(code)) {
        return reply.status(400).send({ error: code });
      }
      if (code === 'central_ledger_read_disabled') return reply.status(409).send({ error: code });
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
