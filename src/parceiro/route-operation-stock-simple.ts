import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getPartnerContext,
  requirePartnerAuth,
  requireScreen,
  type PartnerAuthedRequest,
} from './auth.js';
import {
  correctSimpleOperationStockBalance,
  createSimpleOperationTire,
  getSimpleOperationStockPrices,
  OperationStockSimpleError,
} from './operation-stock-simple.js';
import { getPartnerSelfIdentity } from './queries.js';

const slugSchema = z.object({ slug: z.string().trim().min(1).max(120) });
const stockParamsSchema = slugSchema.extend({ stockId: z.string().uuid() });
const moneySchema = z.number().positive().max(99_999_999.99)
  .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-7,
    'money_cent_precision');
const tireSizePattern = /^(\d{2,3})\/(\d{2,3})-(\d{2})$/;

const newTireSchema = z.object({
  tire_size: z.string().trim().regex(tireSizePattern, 'invalid_tire_size'),
  brand: z.string().trim().min(1).max(120),
  tire_condition: z.enum(['novo', 'meia_vida', 'remold']),
  quantity_on_hand: z.number().int().nonnegative().max(999_999),
  minimum_quantity: z.number().int().nonnegative().max(999_999).nullable().optional(),
  sale_price: moneySchema,
}).strict();

const balanceSchema = z.object({
  quantity_on_hand: z.number().int().nonnegative().max(999_999),
}).strict();

async function actorFor(request: PartnerAuthedRequest): Promise<string> {
  const ctx = getPartnerContext(request);
  const identity = await getPartnerSelfIdentity(ctx);
  return identity.display_name || identity.username || `owner:${ctx.tokenId}`;
}

function simpleError(error: unknown) {
  return error instanceof OperationStockSimpleError
    ? { status: error.status, code: error.code }
    : null;
}

export function registerPartnerOperationStockSimpleRoutes(fastify: FastifyInstance): void {
  fastify.get('/parceiro/:slug/api/operacao/estoque-valores', {
    preHandler: [requirePartnerAuth, requireScreen('estoque')],
  }, async (request: PartnerAuthedRequest, reply) => {
    const params = slugSchema.safeParse(request.params);
    if (!params.success) return reply.status(404).send({ error: 'partner_not_found' });
    return reply.status(200).send({ rows: await getSimpleOperationStockPrices(getPartnerContext(request)) });
  });

  fastify.post('/parceiro/:slug/api/operacao/estoque/itens', {
    preHandler: [requirePartnerAuth, requireScreen('estoque')],
  }, async (request: PartnerAuthedRequest, reply) => {
    const params = slugSchema.safeParse(request.params);
    const body = newTireSchema.safeParse(request.body ?? {});
    if (!params.success) return reply.status(404).send({ error: 'partner_not_found' });
    if (!body.success) {
      return reply.status(400).send({ error: body.error.issues[0]?.message ?? 'invalid_body' });
    }
    const match = tireSizePattern.exec(body.data.tire_size)!;
    try {
      const result = await createSimpleOperationTire(
        getPartnerContext(request), await actorFor(request), {
          ...body.data,
          tire_width_mm: Number(match[1]),
          tire_aspect_ratio: Number(match[2]),
          tire_rim_diameter: Number(match[3]),
        },
      );
      return reply.status(201).send(result);
    } catch (error) {
      const known = simpleError(error);
      if (known) return reply.status(known.status).send({ error: known.code });
      throw error;
    }
  });

  fastify.post('/parceiro/:slug/api/operacao/estoque/:stockId/saldo', {
    preHandler: [requirePartnerAuth, requireScreen('estoque')],
  }, async (request: PartnerAuthedRequest, reply) => {
    const params = stockParamsSchema.safeParse(request.params);
    const body = balanceSchema.safeParse(request.body ?? {});
    if (!params.success) return reply.status(404).send({ error: 'stock_not_found' });
    if (!body.success) {
      return reply.status(400).send({ error: body.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const result = await correctSimpleOperationStockBalance(
        getPartnerContext(request), await actorFor(request),
        params.data.stockId, body.data.quantity_on_hand,
      );
      return reply.status(200).send(result);
    } catch (error) {
      const known = simpleError(error);
      if (known) return reply.status(known.status).send({ error: known.code });
      throw error;
    }
  });
}
