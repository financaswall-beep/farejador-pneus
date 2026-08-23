// Obra 300 (2026-07-05): fatia da PORTARIA da matriz — pedido manual/walk-in + cancelar.
// VERBATIM das linhas 1226-1283 do route.ts pré-obra (corpo de registerPainelRoute).
// Registrada por ./route.js (porta de entrada) na ordem original.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAdminContext, requireAdminOwner } from '../auth.js';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/logger.js';
import {
  cancelManualOrder, completeMatrizPickup, getMatrizRetiradas, registerManualOrder,
  registerWalkinOrder, updateMatrizPickupStage,
} from './queries.js';
import { mapWriteError, operatorLabel } from './route-helpers.js';
import { cancelBodySchema, cancelParamsSchema, registerManualOrderSchema, registerWalkinOrderSchema } from './route-schemas.js';
import { pickupServicesPublicCatalog, pickupServicesSchema } from '../../shared/pickup-services.js';

const pickupCompletionSchema = z.object({
  payment_method: z.string().trim().min(1).max(80),
  services: pickupServicesSchema.optional(),
});

const pickupStageSchema = z.object({
  stage: z.enum(['waiting', 'arrived', 'installing']),
  services: pickupServicesSchema.default([]),
});

export async function registerPainelPedidos(fastify: FastifyInstance): Promise<void> {
  fastify.get('/admin/api/retiradas', { preHandler: requireAdminOwner }, async (_request, reply) => {
    return reply.status(200).send({
      rows: await getMatrizRetiradas(),
      service_catalog: pickupServicesPublicCatalog(),
    });
  });

  fastify.put('/admin/api/retiradas/:order_id/stage', { preHandler: requireAdminOwner }, async (request, reply) => {
    const params = cancelParamsSchema.safeParse(request.params);
    const body = pickupStageSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.status(400).send({ error: 'invalid_request' });
    try {
      return reply.status(200).send(await updateMatrizPickupStage({
        order_id: params.data.order_id,
        stage: body.data.stage,
        services: body.data.services,
        actor_label: operatorLabel(request),
      }));
    } catch (err) {
      const mapped = mapWriteError(err);
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  fastify.post('/admin/api/orders/register-manual', { preHandler: requireAdminOwner }, async (request, reply) => {
    const parsed = registerManualOrderSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }

    try {
      const result = await registerManualOrder({
        ...parsed.data,
        environment: env.FAREJADOR_ENV,
        actor_label: operatorLabel(request),
        seller_collaborator_id: getAdminContext(request).collaboratorId,
      });
      return reply.status(200).send(result);
    } catch (err) {
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel manual order registration failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  fastify.post('/admin/api/orders/register-walkin', { preHandler: requireAdminOwner }, async (request, reply) => {
    const parsed = registerWalkinOrderSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }

    try {
      const result = await registerWalkinOrder({
        ...parsed.data,
        environment: env.FAREJADOR_ENV,
        actor_label: operatorLabel(request),
        seller_collaborator_id: getAdminContext(request).collaboratorId,
      });
      return reply.status(200).send(result);
    } catch (err) {
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel walkin order registration failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  fastify.post('/admin/api/orders/:order_id/cancel', { preHandler: requireAdminOwner }, async (request, reply) => {
    const params = cancelParamsSchema.safeParse(request.params);
    const body = cancelBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ error: 'invalid_request' });
    }

    try {
      return reply.status(200).send(await cancelManualOrder({
        order_id: params.data.order_id,
        reason: body.data.reason,
        actor_label: operatorLabel(request),
      }));
    } catch (err) {
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel manual order cancellation failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  fastify.post('/admin/api/orders/:order_id/retrieve', { preHandler: requireAdminOwner }, async (request, reply) => {
    const params = cancelParamsSchema.safeParse(request.params);
    const body = pickupCompletionSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.status(400).send({ error: 'invalid_request' });
    try {
      return reply.status(200).send(await completeMatrizPickup({
        order_id: params.data.order_id,
        actor_label: operatorLabel(request),
        payment_method: body.data.payment_method,
        services: body.data.services,
      }));
    } catch (err) {
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel matriz pickup completion failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

}
