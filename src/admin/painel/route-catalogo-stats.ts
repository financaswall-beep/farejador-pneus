import type { FastifyReply, FastifyRequest } from 'fastify';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/logger.js';
import { getCatalogProductStats } from './queries-catalogo-stats.js';
import { productParams } from './route-catalogo-schemas.js';

export async function catalogProductStats(request: FastifyRequest, reply: FastifyReply) {
  reply.header('Cache-Control', 'no-store');
  const params = productParams.safeParse(request.params);
  if (!params.success) return reply.code(400).send({ error: 'invalid_product_id' });
  try {
    const stats = await getCatalogProductStats(pool, env.FAREJADOR_ENV, params.data.product_id);
    if (!stats) return reply.code(404).send({ error: 'catalog_product_not_found' });
    return reply.send(stats);
  } catch (error) {
    logger.error({ err: error }, 'catalog product statistics failed');
    return reply.code(500).send({ error: 'internal_server_error' });
  }
}
