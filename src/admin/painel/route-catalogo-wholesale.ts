import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminAuth, requireAdminOwner } from '../auth.js';
import { logger } from '../../shared/logger.js';
import { operatorLabel } from './route-helpers.js';
import { productParams } from './route-catalogo-schemas.js';
import { getCatalogWholesaleHistory, setCatalogWholesalePrice } from './queries-catalogo-wholesale.js';

const bodySchema = z.object({
  price_amount: z.number().positive().max(9_999_999.99)
    .refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 1e-7).nullable(),
  reason: z.string().trim().min(2).max(500),
}).strict();

export async function registerCatalogWholesale(fastify: FastifyInstance) {
  fastify.get('/admin/api/catalog/:product_id/wholesale-history',
    { preHandler: requireAdminAuth }, async (request, reply) => {
      const params = productParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: 'invalid_catalog_product' });
      return { rows: await getCatalogWholesaleHistory(params.data.product_id) };
    });
  fastify.post('/admin/api/catalog/:product_id/wholesale-price',
    { preHandler: requireAdminOwner }, async (request, reply) => {
      const params = productParams.safeParse(request.params);
      const body = bodySchema.safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_catalog_wholesale_price' });
      try {
        return await setCatalogWholesalePrice({ productId: params.data.product_id,
          priceAmount: body.data.price_amount, reason: body.data.reason, actorLabel: operatorLabel(request) });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'internal_server_error';
        const status = message === 'catalog_product_not_found' ? 404
          : message.startsWith('catalog_wholesale_') ? 400 : 500;
        if (status === 500) logger.error({ error }, 'catalog wholesale price update failed');
        return reply.code(status).send({ error: status === 500 ? 'internal_server_error' : message });
      }
    });
}
