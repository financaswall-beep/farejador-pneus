import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { logger } from '../../shared/logger.js';
import type { CaixaAuth } from './queries.js';
import {
  getMatrizOperationCommissionDetail,
  getMatrizOperationCommissions,
  payMatrizOperationCommission,
} from './operation-commissions.js';

type Gate = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
type AuthenticatedRequest = FastifyRequest & { caixa?: CaixaAuth };

const rangeSchema = z.object({
  range: z.enum(['today', '7d', '15d', '30d']).default('30d'),
});
const paramsSchema = z.object({ collaboratorId: z.string().uuid() });
const paymentSchema = z.object({
  payment_target_id: z.string().uuid(),
  idempotency_key: z.string().trim().min(8).max(200),
});

export function registerCaixaCommissionRoutes(
  fastify: FastifyInstance,
  flagGate: Gate,
  requireAuth: Gate,
  requireFinance: Gate,
): void {
  const requireOwner: Gate = async (request, reply) => {
    if ((request as AuthenticatedRequest).caixa?.panelRole !== 'owner') {
      await reply.status(403).send({ error: 'owner_required' });
    }
  };
  const guards = [flagGate, requireAuth, requireFinance, requireOwner];

  fastify.get('/api/caixa/financeiro-comissoes', { preHandler: guards }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = rangeSchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_query' });
    try {
      return reply.status(200).send(await getMatrizOperationCommissions(parsed.data.range));
    } catch (error) {
      logger.error({ err: error }, 'matrix operation commissions unavailable');
      return reply.status(503).send({ error: 'commission_unavailable' });
    }
  });

  fastify.get('/api/caixa/financeiro-comissoes/:collaboratorId', {
    preHandler: guards,
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const query = rangeSchema.safeParse(request.query ?? {});
    const params = paramsSchema.safeParse(request.params ?? {});
    if (!query.success || !params.success) return reply.status(400).send({ error: 'invalid_request' });
    try {
      const payload = await getMatrizOperationCommissionDetail(
        params.data.collaboratorId, query.data.range,
      );
      return payload
        ? reply.status(200).send(payload)
        : reply.status(404).send({ error: 'collaborator_not_found' });
    } catch (error) {
      logger.error({ err: error }, 'matrix operation commission detail unavailable');
      return reply.status(503).send({ error: 'commission_unavailable' });
    }
  });

  fastify.post('/api/caixa/financeiro-comissoes/:collaboratorId/pagar', {
    preHandler: guards,
  }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params ?? {});
    const body = paymentSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.status(400).send({ error: 'invalid_request' });
    const auth = (request as AuthenticatedRequest).caixa!;
    try {
      return reply.status(200).send(await payMatrizOperationCommission(
        params.data.collaboratorId,
        body.data.payment_target_id,
        body.data.idempotency_key,
        auth.displayName,
      ));
    } catch (error) {
      const code = error instanceof Error ? error.message : 'commission_payment_failed';
      if (['commission_payment_not_available', 'idempotency_conflict', 'idempotency_incomplete']
        .includes(code)) return reply.status(409).send({ error: code });
      logger.error({ err: error }, 'matrix operation commission payment failed');
      return reply.status(500).send({ error: 'commission_payment_failed' });
    }
  });
}
