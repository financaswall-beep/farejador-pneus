import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getPartnerContext,
  requirePartnerAuth,
  requireScreen,
  type PartnerAuthedRequest,
} from './auth.js';
import {
  getPartnerPanelCatalog,
  getPartnerPanelCatalogCompatibility,
  PartnerPanelCatalogNotFoundError,
} from './panel-catalog.js';

const catalogScreen = [requirePartnerAuth, requireScreen('catalogo')];
const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(40),
  q: z.string().trim().max(120).optional(),
  brand: z.string().trim().max(80).optional(),
  type: z.enum(['all', 'tire', 'service']).default('all'),
  filter: z.enum(['all', 'stock', 'no_price']).default('all'),
});
const productParams = z.object({ productId: z.string().uuid() });

/** Catálogo da unidade: leitura segue a permissão explícita de Catálogo. */
export function registerPartnerPanelCatalogRoutes(fastify: FastifyInstance): void {
  fastify.get('/parceiro/:slug/api/painel/catalogo', {
    preHandler: catalogScreen,
  }, async (request: PartnerAuthedRequest, reply) => {
    const parsed = querySchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_catalog_query' });
    reply.header('Cache-Control', 'no-store');
    return reply.status(200).send(await getPartnerPanelCatalog(
      getPartnerContext(request), parsed.data,
    ));
  });

  fastify.get('/parceiro/:slug/api/painel/catalogo/:productId/compatibilidade', {
    preHandler: catalogScreen,
  }, async (request: PartnerAuthedRequest, reply) => {
    const parsed = productParams.safeParse(request.params ?? {});
    if (!parsed.success) return reply.status(404).send({ error: 'catalog_product_not_found' });
    reply.header('Cache-Control', 'no-store');
    try {
      return reply.status(200).send(await getPartnerPanelCatalogCompatibility(
        getPartnerContext(request), parsed.data.productId,
      ));
    } catch (error) {
      if (error instanceof PartnerPanelCatalogNotFoundError) {
        return reply.status(404).send({ error: error.message });
      }
      throw error;
    }
  });
}
