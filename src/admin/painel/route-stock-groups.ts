import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/logger.js';
import { requireAdminAuth, requireAdminOwner } from '../auth.js';
import { operatorLabel, mapWriteError } from './route-helpers.js';
import { listMatrizStockGroups, moveMatrizStockGroup, saveMatrizStockGroup } from './stock-groups.js';
import { listMatrizStockGroupOptions, stockGroupId, stockGroupMoveBody, stockGroupSchema } from './stock-group-inputs.js';

function failure(reply: FastifyReply, error: unknown) {
  const code = error instanceof Error ? error.message : '';
  if (code === 'stock_group_not_found') return reply.status(404).send({ error: code });
  if (['stock_group_invalid', 'stock_group_invalid_positions', 'stock_group_invalid_inspection',
    'stock_group_product_mismatch', 'stock_group_model_required', 'stock_group_revision_required',
    'stock_group_move_required', 'reason_required'].includes(code)) {
    return reply.status(400).send({ error: code });
  }
  if (['stock_group_offer_changed', 'stock_group_unavailable', 'stock_group_not_editable', 'stock_group_protected'].includes(code)) {
    return reply.status(409).send({ error: code });
  }
  const mapped = mapWriteError(error);
  if (mapped.status >= 500) logger.error({ err: error }, 'stock groups operation failed');
  return reply.status(mapped.status).send({ error: mapped.error });
}

export function registerStockGroupRoutes(fastify: FastifyInstance): void {
  const base = '/admin/api/wholesale/stock/groups';
  fastify.get(base, { preHandler: requireAdminAuth }, async (request, reply) => {
    const query = z.object({ stock_id: stockGroupId.optional() }).strict().safeParse(request.query);
    if (!query.success) return reply.status(400).send({ error: 'stock_group_invalid' });
    reply.header('Cache-Control', 'no-store');
    try {
      const [groups, stock] = await Promise.all([
        listMatrizStockGroups(pool, env.FAREJADOR_ENV, query.data.stock_id),
        listMatrizStockGroupOptions(pool, env.FAREJADOR_ENV, query.data.stock_id),
      ]);
      return reply.send({ groups, stock });
    } catch (error) { return failure(reply, error); }
  });

  fastify.post(base, { preHandler: requireAdminOwner }, async (request, reply) => {
    const parsed = stockGroupSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues.find(issue => issue.code === 'custom')?.message || 'stock_group_invalid' });
    try {
      return reply.send(await saveMatrizStockGroup(pool, env.FAREJADOR_ENV, parsed.data, operatorLabel(request)));
    } catch (error) { return failure(reply, error); }
  });

  fastify.post(base + '/:groupId/move', { preHandler: requireAdminOwner }, async (request, reply) => {
    const params = z.object({ groupId: stockGroupId }).safeParse(request.params);
    const parsed = stockGroupMoveBody.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.status(400).send({ error: 'stock_group_invalid' });
    try {
      return reply.send(await moveMatrizStockGroup(pool, env.FAREJADOR_ENV,
        { ...parsed.data, group_id: params.data.groupId }, operatorLabel(request)));
    } catch (error) { return failure(reply, error); }
  });
}
