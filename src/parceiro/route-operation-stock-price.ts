import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getPartnerContext,
  requireOwner,
  requirePartnerAuth,
  type PartnerAuthedRequest,
} from './auth.js';
import { getPartnerSelfIdentity } from './queries.js';
import {
  OperationStockPriceError,
  setPartnerOperationStockPrice,
} from './operation-stock-price.js';

const paramsSchema = z.object({
  slug: z.string().min(1).max(120),
  stockId: z.string().uuid(),
});
const bodySchema = z.object({
  sale_price: z.number().positive().max(99_999_999.99)
    .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-7, 'money_cent_precision'),
  reason: z.string().trim().min(3).max(500),
}).strict();

export function registerPartnerOperationStockPriceRoutes(fastify: FastifyInstance): void {
  fastify.post('/parceiro/:slug/api/operacao/estoque/:stockId/preco', {
    preHandler: [requirePartnerAuth, requireOwner],
  }, async (request: PartnerAuthedRequest, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const body = bodySchema.safeParse(request.body ?? {});
    if (!params.success) return reply.status(404).send({ error: 'stock_not_found' });
    if (!body.success) {
      return reply.status(400).send({ error: body.error.issues[0]?.message ?? 'invalid_body' });
    }
    const ctx = getPartnerContext(request);
    const identity = await getPartnerSelfIdentity(ctx);
    const actor = identity.display_name || identity.username || `owner:${ctx.tokenId}`;
    try {
      return reply.status(200).send(await setPartnerOperationStockPrice(
        ctx, actor, params.data.stockId, body.data.sale_price, body.data.reason,
      ));
    } catch (error) {
      if (error instanceof OperationStockPriceError) {
        return reply.status(error.status).send({ error: error.code });
      }
      throw error;
    }
  });
}
