// Obra 300 (2026-07-05): fatia da PORTARIA da matriz — pedido manual/walk-in + cancelar.
// VERBATIM das linhas 1226-1283 do route.ts pré-obra (corpo de registerPainelRoute).
// Registrada por ./route.js (porta de entrada) na ordem original.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminAuth } from '../auth.js';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/logger.js';
import { cancelManualOrder, registerManualOrder, registerWalkinOrder } from './queries.js';
import { mapWriteError, operatorLabel } from './route-helpers.js';
import { cancelBodySchema, cancelParamsSchema, registerManualOrderSchema, registerWalkinOrderSchema } from './route-schemas.js';

export async function registerPainelPedidos(fastify: FastifyInstance): Promise<void> {
  fastify.post('/admin/api/orders/register-manual', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = registerManualOrderSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }

    try {
      const result = await registerManualOrder({
        ...parsed.data,
        actor_label: operatorLabel(request.headers),
      });
      return reply.status(200).send(result);
    } catch (err) {
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel manual order registration failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  fastify.post('/admin/api/orders/register-walkin', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = registerWalkinOrderSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }

    try {
      const result = await registerWalkinOrder({
        ...parsed.data,
        actor_label: operatorLabel(request.headers),
      });
      return reply.status(200).send(result);
    } catch (err) {
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel walkin order registration failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  fastify.post('/admin/api/orders/:order_id/cancel', { preHandler: requireAdminAuth }, async (request, reply) => {
    const params = cancelParamsSchema.safeParse(request.params);
    const body = cancelBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ error: 'invalid_request' });
    }

    try {
      return reply.status(200).send(await cancelManualOrder({
        order_id: params.data.order_id,
        reason: body.data.reason,
        actor_label: operatorLabel(request.headers),
      }));
    } catch (err) {
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel manual order cancellation failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

}
