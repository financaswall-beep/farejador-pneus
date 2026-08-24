import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { CaixaAuth } from './queries.js';
import {
  cancelMatrizPickup,
  completeMatrizPickup,
  getMatrizRetiradas,
  updateMatrizPickupStage,
} from '../painel/queries.js';
import { mapWriteError } from '../painel/route-helpers.js';
import { pickupServicesPublicCatalog, pickupServicesSchema } from '../../shared/pickup-services.js';

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
type CaixaRequest = FastifyRequest & { caixa?: CaixaAuth };

const paramsSchema = z.object({ orderId: z.string().uuid() });
const stageSchema = z.object({
  stage: z.enum(['waiting', 'arrived', 'installing']),
  services: pickupServicesSchema.default([]),
});
const completionSchema = z.object({
  payment_method: z.string().trim().min(1).max(80),
  services: pickupServicesSchema.optional(),
});
const cancelSchema = z.object({ reason: z.string().trim().min(1).max(500) });

function authOf(request: FastifyRequest): CaixaAuth {
  return (request as CaixaRequest).caixa!;
}

function actorOf(request: FastifyRequest): string {
  const auth = authOf(request);
  return `Caixa: ${auth.displayName} (${auth.username})`.slice(0, 120);
}

function mappedError(reply: FastifyReply, error: unknown) {
  const mapped = mapWriteError(error);
  return reply.status(mapped.status).send({ error: mapped.error });
}

export function registerCaixaPickupRoutes(
  fastify: FastifyInstance,
  flagGate: PreHandler,
  requireCaixaAuth: PreHandler,
  requirePickups: PreHandler,
): void {
  const guarded = [flagGate, requireCaixaAuth, requirePickups];

  fastify.get('/api/caixa/retiradas', { preHandler: guarded }, async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return reply.status(200).send({
      rows: await getMatrizRetiradas(),
      service_catalog: pickupServicesPublicCatalog(),
    });
  });

  fastify.put('/api/caixa/retiradas/:orderId/stage', { preHandler: guarded }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const body = stageSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.status(400).send({ error: 'invalid_request' });
    try {
      return reply.status(200).send(await updateMatrizPickupStage({
        order_id: params.data.orderId,
        stage: body.data.stage,
        services: body.data.services,
        actor_label: actorOf(request),
      }));
    } catch (error) {
      return mappedError(reply, error);
    }
  });

  fastify.post('/api/caixa/retiradas/:orderId', { preHandler: guarded }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const body = completionSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.status(400).send({ error: 'invalid_request' });
    try {
      return reply.status(200).send(await completeMatrizPickup({
        order_id: params.data.orderId,
        actor_label: actorOf(request),
        payment_method: body.data.payment_method,
        services: body.data.services,
      }));
    } catch (error) {
      return mappedError(reply, error);
    }
  });

  fastify.delete('/api/caixa/retiradas/:orderId', { preHandler: guarded }, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const body = cancelSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) return reply.status(400).send({ error: 'invalid_request' });
    try {
      return reply.status(200).send(await cancelMatrizPickup({
        order_id: params.data.orderId,
        reason: body.data.reason,
        actor_label: actorOf(request),
      }));
    } catch (error) {
      return mappedError(reply, error);
    }
  });
}
