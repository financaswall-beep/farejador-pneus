import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminAuth } from '../auth.js';
import { logger } from '../../shared/logger.js';
import { getCatalogOverview, getCatalogPriceHistory, setCatalogPrice } from './queries-catalogo.js';
import { operatorLabel } from './route-helpers.js';

const productParams = z.object({ product_id: z.string().uuid() });
const priceBody = z.object({
  price_amount: z.number().positive().max(9_999_999.99),
  reason: z.string().trim().min(2).max(500),
});

export async function registerPainelCatalogo(fastify: FastifyInstance): Promise<void> {
  fastify.get('/admin/api/catalog', { preHandler: requireAdminAuth }, async (_request, reply) => {
    return reply.status(200).send(await getCatalogOverview());
  });

  fastify.get('/admin/api/catalog/:product_id/history', { preHandler: requireAdminAuth }, async (request, reply) => {
    const params = productParams.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'invalid_product_id' });
    return reply.status(200).send({ rows: await getCatalogPriceHistory(params.data.product_id) });
  });

  fastify.post('/admin/api/catalog/:product_id/price', { preHandler: requireAdminAuth }, async (request, reply) => {
    const params = productParams.safeParse(request.params);
    const body = priceBody.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ error: 'invalid_catalog_price' });
    try {
      return reply.status(200).send(await setCatalogPrice({
        productId: params.data.product_id,
        priceAmount: body.data.price_amount,
        reason: body.data.reason,
        actorLabel: operatorLabel(request),
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'internal_server_error';
      const status = message === 'catalog_product_not_found' ? 404
        : message.startsWith('catalog_price_') ? 400 : 500;
      logger.error({ error, status }, 'painel catalog price update failed');
      return reply.status(status).send({ error: status === 500 ? 'internal_server_error' : message });
    }
  });
}
