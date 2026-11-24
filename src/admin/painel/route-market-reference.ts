import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getMarketReference, marketReferenceSchema, setMarketReference } from '../../shared/catalog-market-reference.js';
import { logger } from '../../shared/logger.js';
import { requireAdminOwner } from '../auth.js';
import { operatorLabel } from './route-helpers.js';
import { productParams } from './route-catalogo-schemas.js';

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
const bodyFields = z.record(z.string(), z.unknown());

function failure(reply: FastifyReply, error: unknown) {
  const code = error instanceof Error ? error.message : '';
  if (code === 'catalog_product_not_found') return reply.status(404).send({ error: code });
  if (code === 'market_reference_model_mismatch') return reply.status(409).send({ error: code });
  if (['market_reference_dates_invalid', 'market_reference_invalid'].includes(code)) {
    return reply.status(400).send({ error: code });
  }
  logger.error({ err: error }, 'catalog market reference failed');
  return reply.status(500).send({ error: 'internal_server_error' });
}

export function registerMarketReferenceRoutes(
  fastify: FastifyInstance,
  base = '/admin/api/catalog',
  guards: Guard[] = [requireAdminOwner],
  actor = operatorLabel,
): void {
  const path = base + '/:product_id/market-reference';
  fastify.get(path, { preHandler: guards }, async (request, reply) => {
    const params = productParams.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'invalid_product_id' });
    reply.header('Cache-Control', 'no-store');
    try {
      return reply.send({ reference: await getMarketReference(params.data.product_id) });
    } catch (error) { return failure(reply, error); }
  });

  fastify.put(path, { preHandler: guards }, async (request, reply) => {
    const params = productParams.safeParse(request.params);
    const body = bodyFields.safeParse(request.body);
    if (!params.success || !body.success || 'product_id' in body.data) {
      return reply.status(400).send({ error: 'market_reference_invalid' });
    }
    const parsed = marketReferenceSchema.safeParse({ ...body.data, product_id: params.data.product_id });
    if (!parsed.success) {
      const datesInvalid = parsed.error.issues.some(issue => issue.message === 'market_reference_dates_invalid');
      return reply.status(400).send({ error: datesInvalid ? 'market_reference_dates_invalid' : 'market_reference_invalid' });
    }
    try {
      return reply.send({ reference: await setMarketReference(parsed.data, actor(request)) });
    } catch (error) { return failure(reply, error); }
  });
}
