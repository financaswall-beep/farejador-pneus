import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminOwner } from '../auth.js';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/logger.js';
import { settleMatrizLedgerOpenItem } from './matriz-ledger-settlement.js';
import { mapWriteError, operatorLabel } from './route-helpers.js';

const settleLedgerItemSchema = z.object({
  obligation_id: z.string().uuid().optional(),
  account_code: z.literal('marketing_payable').optional(),
  amount: z.number().positive().max(999_999_999.99).optional(),
  payment_method: z.string().trim().min(2).max(40).optional(),
  idempotency_key: z.string().trim().min(8).max(200),
}).refine((body) => Boolean(body.obligation_id) !== Boolean(body.account_code), {
  message: 'settlement_target_invalid',
});

export async function registerPainelFinanceiroLedger(
  fastify: FastifyInstance,
): Promise<void> {
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
}
