import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getPartnerContext,
  requirePartnerAuth,
  requireScreen,
  type PartnerAuthedRequest,
} from './auth.js';
import { getOperationStockDetail } from './operation-stock-detail.js';

const paramsSchema = z.object({
  slug: z.string().min(1).max(120),
  stockId: z.string().uuid(),
});
const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(3).max(50).default(20),
});

export function registerPartnerOperationStockDetailRoutes(fastify: FastifyInstance): void {
  fastify.get('/parceiro/:slug/api/operacao/estoque/:stockId', {
    preHandler: [requirePartnerAuth, requireScreen('estoque')],
  }, async (request: PartnerAuthedRequest, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const query = querySchema.safeParse(request.query ?? {});
    if (!params.success || !query.success) return reply.status(404).send({ error: 'stock_not_found' });
    const result = await getOperationStockDetail(
      getPartnerContext(request), params.data.stockId, query.data.page, query.data.limit,
    );
    return result
      ? reply.status(200).send(result)
      : reply.status(404).send({ error: 'stock_not_found' });
  });
}
