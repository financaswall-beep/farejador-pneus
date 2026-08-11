import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  getPartnerContext,
  requireOwner,
  requirePartnerAuth,
  requireScreen,
  type PartnerAuthedRequest,
} from './auth.js';
import { OperationStockReviewError } from './operation-stock-owner.js';
import {
  approveOperationStockUpdate,
  OperationStockUpdateError,
  requestOperationStockUpdate,
} from './operation-stock-update.js';
import { getPartnerSelfIdentity } from './queries.js';

const paramsSchema = z.object({
  slug: z.string().min(1).max(120),
  stockId: z.string().uuid().optional(),
  requestId: z.string().uuid().optional(),
});
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const updateSchema = z.object({
  local_sku: optionalText(80),
  item_name: z.string().trim().min(2).max(240),
  tire_width_mm: z.number().int().min(1).max(999).nullable().optional(),
  tire_aspect_ratio: z.number().int().min(1).max(999).nullable().optional(),
  tire_rim_diameter: z.number().int().min(1).max(30).nullable().optional(),
  brand: optionalText(120),
  minimum_quantity: z.number().int().nonnegative().max(999999).nullable().optional(),
  tire_condition: z.enum(['meia_vida', 'novo', 'remold']).nullable().optional(),
  shelf_location: optionalText(60),
  tire_position: z.enum(['Dianteiro', 'Traseiro', 'Ambos']).nullable().optional(),
  idempotency_key: z.string().min(8).max(120),
}).strict();

function validationError(reply: FastifyReply, parsed: { error: z.ZodError }): FastifyReply {
  const issue = parsed.error.issues[0];
  return reply.status(400).send({
    error: `${issue?.path.join('.') || 'body'}: ${issue?.message || 'invalid'}`,
  });
}

async function actorLabel(request: PartnerAuthedRequest): Promise<string> {
  const ctx = getPartnerContext(request);
  const identity = await getPartnerSelfIdentity(ctx);
  return identity.display_name || identity.username || `funcionario:${ctx.tokenId}`;
}

function stockError(reply: FastifyReply, error: unknown): FastifyReply | null {
  if (error instanceof OperationStockUpdateError || error instanceof OperationStockReviewError) {
    return reply.status(error.status).send({ error: error.code });
  }
  return null;
}

export function registerPartnerOperationStockUpdateRoutes(fastify: FastifyInstance): void {
  fastify.post('/parceiro/:slug/api/operacao/estoque/:stockId/edicoes', {
    preHandler: [requirePartnerAuth, requireScreen('estoque')],
  }, async (request: PartnerAuthedRequest, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const body = updateSchema.safeParse(request.body ?? {});
    if (!params.success || !params.data.stockId) {
      return reply.status(404).send({ error: 'stock_not_found' });
    }
    if (!body.success) return validationError(reply, body);
    try {
      const result = await requestOperationStockUpdate(
        getPartnerContext(request), await actorLabel(request), params.data.stockId, body.data,
      );
      return reply.status(202).send(result);
    } catch (error) {
      return stockError(reply, error) ?? Promise.reject(error);
    }
  });

  fastify.post('/parceiro/:slug/api/operacao/estoque/edicoes/:requestId/aprovar', {
    preHandler: [requirePartnerAuth, requireOwner],
  }, async (request: PartnerAuthedRequest, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success || !params.data.requestId) {
      return reply.status(400).send({ error: 'requestId: invalid' });
    }
    try {
      const result = await approveOperationStockUpdate(
        getPartnerContext(request), await actorLabel(request), params.data.requestId,
      );
      return reply.status(200).send(result);
    } catch (error) {
      return stockError(reply, error) ?? Promise.reject(error);
    }
  });
}
