import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/logger.js';
import { requireAdminAuth, requireAdminOwner } from '../auth.js';
import { operatorLabel } from './route-helpers.js';
import { stockOriginConfirmationBody } from './stock-origin-inputs.js';
import { confirmStockOrigin, listStockOriginPendings } from './stock-origin.js';

export function stockOriginError(reply: FastifyReply, error: unknown) {
  const code = error instanceof Error ? error.message : '';
  if (code === 'stock_origin_not_found') return reply.status(404).send({ error: code });
  if (code === 'stock_origin_changed' || code === 'idempotency_conflict') return reply.status(409).send({ error: code });
  if (code === 'stock_origin_invalid') return reply.status(400).send({ error: code });
  logger.error({ err: error }, 'stock origin operation failed');
  return reply.status(500).send({ error: 'internal_server_error' });
}

export function registerStockOriginRoutes(fastify: FastifyInstance) {
  const base = '/admin/api/wholesale/stock/origins';
  fastify.get(base, { preHandler: requireAdminAuth }, async (request, reply) => {
    const filters = z.object({ stock_id: z.string().uuid().optional(), order_id: z.string().uuid().optional(),
      order_number: z.string().trim().min(1).max(80).optional() }).strict().safeParse(request.query);
    if (!filters.success) return reply.status(400).send({ error: 'stock_origin_invalid' });
    reply.header('Cache-Control', 'no-store');
    try {
      return { rows: await listStockOriginPendings(pool, env.FAREJADOR_ENV, { stockId: filters.data.stock_id, orderNumber: filters.data.order_number,
        orderIds: filters.data.order_id ? [filters.data.order_id] : undefined }) };
    } catch (error) { return stockOriginError(reply, error); }
  });
  fastify.post(base + '/:pendingId', { preHandler: requireAdminOwner }, async (request, reply) => {
    const params = z.object({ pendingId: z.string().uuid() }).safeParse(request.params);
    const body = stockOriginConfirmationBody.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ error: 'stock_origin_invalid' });
    reply.header('Cache-Control', 'no-store');
    try { return await confirmStockOrigin(pool, env.FAREJADOR_ENV, { ...body.data, pending_id: params.data.pendingId }, operatorLabel(request)); }
    catch (error) { return stockOriginError(reply, error); }
  });
}
