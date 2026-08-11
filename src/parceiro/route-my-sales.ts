import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getPartnerContext,
  requirePartnerAuth,
  requireScreen,
  type PartnerAuthedRequest,
} from './auth.js';
import { getPartnerMyPerformance } from './commission-ledger.js';
import { getPartnerMySaleDetail, getPartnerMySales } from './my-sales.js';

const weekQuerySchema = z.object({
  week: z.coerce.number().int().min(-52).max(0).default(0),
});
const orderParamsSchema = z.object({ orderId: z.string().uuid() });

export function registerPartnerMySalesRoutes(fastify: FastifyInstance): void {
  fastify.get('/parceiro/:slug/api/meu-desempenho', {
    preHandler: requirePartnerAuth,
  }, async (request: PartnerAuthedRequest, reply) => {
    return reply.status(200).send(await getPartnerMyPerformance(getPartnerContext(request)));
  });

  fastify.get('/parceiro/:slug/api/minhas-vendas', {
    preHandler: [requirePartnerAuth, requireScreen('vendas')],
  }, async (request: PartnerAuthedRequest, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = weekQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_query' });
    return reply.status(200).send(
      await getPartnerMySales(getPartnerContext(request), parsed.data.week),
    );
  });

  fastify.get('/parceiro/:slug/api/minhas-vendas/:orderId', {
    preHandler: [requirePartnerAuth, requireScreen('vendas')],
  }, async (request: PartnerAuthedRequest, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = orderParamsSchema.safeParse(request.params ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_order_id' });
    const detail = await getPartnerMySaleDetail(getPartnerContext(request), parsed.data.orderId);
    if (!detail) return reply.status(404).send({ error: 'sale_not_found' });
    return reply.status(200).send(detail);
  });
}
