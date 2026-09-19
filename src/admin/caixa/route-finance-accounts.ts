import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { CaixaAuth } from './queries.js';
import { settleFinanceItem, settleFinanceItemSchema } from '../painel/finance-settlement-service.js';
import { mapWriteError } from '../painel/route-helpers.js';
import { logger } from '../../shared/logger.js';

type Gate = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
export function registerCaixaFinanceAccountsRoutes(app: FastifyInstance, flag: Gate, auth: Gate, finance: Gate) {
  app.post('/api/caixa/financeiro-contas/baixar', { preHandler: [flag, auth, finance, async (request, reply) => {
    if ((request as FastifyRequest & { caixa?: CaixaAuth }).caixa?.panelRole !== 'owner') {
      await reply.code(403).send({ error: 'owner_required' });
    }
  }] }, async (request, reply) => {
    const parsed = settleFinanceItemSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    try {
      const actor = (request as FastifyRequest & { caixa: CaixaAuth }).caixa.displayName;
      return { settled: true, result: await settleFinanceItem(parsed.data, actor) };
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (['central_ledger_read_disabled', 'settlement_exceeds_balance', 'central_obligation_not_open',
        'retail_receivable_not_open', 'payroll_payment_conflict', 'commission_refund_not_pending'].includes(code)) {
        return reply.code(409).send({ error: code });
      }
      if (['settlement_amount_invalid', 'settlement_amount_cent_precision', 'retail_payment_method_required',
        'central_obligation_not_actionable'].includes(code)) return reply.code(400).send({ error: code });
      if (['receivable_not_found', 'payable_not_found', 'expense_not_found', 'nothing_open',
        'monthly_fee_not_found', 'commission_refund_not_found'].includes(code)) return reply.code(404).send({ error: code });
      const mapped = mapWriteError(error);
      logger.error({ err: error }, 'app finance settlement failed');
      return reply.code(mapped.status).send({ error: mapped.error });
    }
  });
}
