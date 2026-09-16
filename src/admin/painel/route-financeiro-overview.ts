import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminAuth, requireAdminOwner } from '../auth.js';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/logger.js';
import { isNotFutureBusinessDate } from '../../shared/business-time.js';
import { operatorLabel } from './route-helpers.js';
import { getMatrizFinanceOverview } from './matriz-finance-overview.js';
import { createOwnerWithdrawal, reverseOwnerWithdrawal } from './matriz-owner-withdrawal.js';

const date = z.string().datetime({ offset: true }).refine(isNotFutureBusinessDate, 'future_date');
const correction = z.object({
  occurred_at: date, reason: z.string().trim().min(3).max(400),
  idempotency_key: z.string().trim().min(8).max(200),
}).strict();
export const ownerWithdrawalSchema = correction.extend({
  amount: z.number().positive().max(999_999_999.99)
    .refine(v => Math.abs(v * 100 - Math.round(v * 100)) < 1e-7, 'amount_cent_precision'),
  payment_method: z.enum(['dinheiro', 'pix', 'transferencia']),
  cash_account: z.string().trim().min(2).max(80),
});
const enabled = () => env.MATRIZ_CENTRAL_LEDGER && env.MATRIZ_CENTRAL_LEDGER_READ;

export async function registerFinanceiroOverview(fastify: FastifyInstance) {
  fastify.get('/admin/api/matriz/financeiro/overview', { preHandler: requireAdminAuth }, async (request, reply) => {
    if (!enabled()) return reply.code(409).send({ error: 'central_ledger_read_disabled' });
    const query = z.object({ mes: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }).safeParse(request.query);
    if (!query.success || !isNotFutureBusinessDate(`${query.data.mes}-01T12:00:00-03:00`)) {
      return reply.code(400).send({ error: 'invalid_month' });
    }
    return getMatrizFinanceOverview(query.data.mes);
  });
  fastify.post('/admin/api/matriz/financeiro/withdrawals', { preHandler: requireAdminOwner }, async (request, reply) => {
    if (!enabled()) return reply.code(409).send({ error: 'central_ledger_read_disabled' });
    const parsed = ownerWithdrawalSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_withdrawal' });
    try {
      return reply.code(201).send(await createOwnerWithdrawal(parsed.data, operatorLabel(request)));
    } catch (error) { return writeError(error, reply); }
  });
  fastify.post('/admin/api/matriz/financeiro/withdrawals/:id/reverse', { preHandler: requireAdminOwner }, async (request, reply) => {
    if (!enabled()) return reply.code(409).send({ error: 'central_ledger_read_disabled' });
    const parsed = correction.safeParse(request.body);
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!parsed.success || !params.success) return reply.code(400).send({ error: 'invalid_withdrawal' });
    try {
      return await reverseOwnerWithdrawal(params.data.id, parsed.data, operatorLabel(request));
    } catch (error) { return writeError(error, reply); }
  });
}

function writeError(error: unknown, reply: import('fastify').FastifyReply) {
  const code = error instanceof Error ? error.message : '';
  if (code === 'withdrawal_not_found_or_date_invalid') return reply.code(400).send({ error: code });
  if (['matriz_ledger_idempotency_conflict', 'matriz_ledger_transaction_already_reversed'].includes(code)) {
    return reply.code(409).send({ error: code });
  }
  logger.error({ error }, 'finance owner withdrawal failed');
  return reply.code(500).send({ error: 'internal_server_error' });
}
