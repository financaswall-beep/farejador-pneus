import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPartnerContext, requireOwner, requirePartnerAuth } from './auth.js';
import type { PartnerAuthedRequest } from './auth.js';
import { getPartnerSimpleFinance } from './simple-finance.js';
import { getPartnerFinanceEntries } from './finance-entries.js';
import { getPartnerFinanceOutputs } from './finance-outputs.js';
import {
  getPartnerOperationCommissionDetail,
  getPartnerOperationCommissions,
  payPartnerOperationCommission,
} from './operation-commissions.js';

const querySchema = z.object({
  range: z.enum(['today', '7d', '15d', '30d']).default('30d'),
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
});
const commissionParamsSchema = z.object({ collaboratorId: z.string().uuid() });
const commissionPaymentSchema = z.object({ payment_target_id: z.string().uuid() });

/** Valores consolidados do app operacional ficam exclusivos do proprietário. */
export function registerPartnerSimpleFinanceRoute(fastify: FastifyInstance): void {
  fastify.get('/parceiro/:slug/api/financeiro-simples', {
    preHandler: [requirePartnerAuth, requireOwner],
  }, async (request: PartnerAuthedRequest, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = querySchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_query' });
    return reply.status(200).send(await getPartnerSimpleFinance(
      getPartnerContext(request), parsed.data.range,
    ));
  });
  fastify.get('/parceiro/:slug/api/financeiro-entradas', {
    preHandler: [requirePartnerAuth, requireOwner],
  }, async (request: PartnerAuthedRequest, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = querySchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_query' });
    return reply.status(200).send(await getPartnerFinanceEntries(
      getPartnerContext(request), parsed.data.range,
    ));
  });
  fastify.get('/parceiro/:slug/api/financeiro-saidas', {
    preHandler: [requirePartnerAuth, requireOwner],
  }, async (request: PartnerAuthedRequest, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = querySchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_query' });
    return reply.status(200).send(await getPartnerFinanceOutputs(
      getPartnerContext(request), parsed.data.range,
    ));
  });
  fastify.get('/parceiro/:slug/api/financeiro-comissoes', {
    preHandler: [requirePartnerAuth, requireOwner],
  }, async (request: PartnerAuthedRequest, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = querySchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_query' });
    return reply.status(200).send(await getPartnerOperationCommissions(
      getPartnerContext(request), parsed.data.range,
    ));
  });
  fastify.get('/parceiro/:slug/api/financeiro-comissoes/:collaboratorId', {
    preHandler: [requirePartnerAuth, requireOwner],
  }, async (request: PartnerAuthedRequest, reply) => {
    reply.header('Cache-Control', 'no-store');
    const query = querySchema.safeParse(request.query ?? {});
    const params = commissionParamsSchema.safeParse(request.params ?? {});
    if (!query.success || !params.success) return reply.status(400).send({ error: 'invalid_request' });
    const payload = await getPartnerOperationCommissionDetail(
      getPartnerContext(request), params.data.collaboratorId, query.data.range,
    );
    return payload ? reply.status(200).send(payload) : reply.status(404).send({ error: 'collaborator_not_found' });
  });
  fastify.post('/parceiro/:slug/api/financeiro-comissoes/:collaboratorId/pagar', {
    preHandler: [requirePartnerAuth, requireOwner],
  }, async (request: PartnerAuthedRequest, reply) => {
    const params = commissionParamsSchema.safeParse(request.params ?? {});
    const body = commissionPaymentSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.status(400).send({ error: 'invalid_request' });
    try {
      const payload = await payPartnerOperationCommission(
        getPartnerContext(request), params.data.collaboratorId, body.data.payment_target_id,
      );
      return reply.status(payload.paid ? 200 : 409).send(payload);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'commission_payment_failed';
      if (code === 'commission_payment_not_available') return reply.status(409).send({ error: code });
      throw error;
    }
  });
}
