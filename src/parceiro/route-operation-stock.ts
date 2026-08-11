import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { PHOTO_MAX_UPLOAD_BYTES, PhotoRejectedError, reencodePhoto } from './photo-upload.js';
import { rateLimitHit } from '../shared/rate-limit.js';
import {
  getPartnerContext,
  requirePartnerAuth,
  requireOwner,
  requireScreen,
  type PartnerAuthedRequest,
} from './auth.js';
import { getPartnerSelfIdentity } from './queries.js';
import {
  getOperationStock,
  requestOperationItemRegistration,
  requestOperationStockCount,
  StockUnavailableForCountError,
} from './operation-stock.js';
import {
  attachOperationStockCountEvidence,
  getOperationStockCountEvidence,
  requestOperationStockCountBatch,
} from './operation-stock-count.js';
import {
  approveOperationRegistration,
  approveOperationStockCount,
  getPendingOperationStockRequests,
  OperationStockReviewError,
  rejectOperationStockRequest,
} from './operation-stock-owner.js';

const paramsSchema = z.object({ slug: z.string().min(1).max(120) });
const uuidSchema = z.string().uuid();
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

const itemRegistrationSchema = z.object({
  item_type: z.enum(['pneu', 'insumo', 'servico']),
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
}).strict().superRefine((value, ctx) => {
  if (value.item_type === 'pneu') {
    const required = [
      ['tire_width_mm', value.tire_width_mm],
      ['tire_aspect_ratio', value.tire_aspect_ratio],
      ['tire_rim_diameter', value.tire_rim_diameter],
      ['tire_condition', value.tire_condition],
    ] as const;
    required.forEach(([field, fieldValue]) => {
      if (fieldValue == null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: 'required_for_tire' });
    });
  }
  if (value.item_type === 'servico') {
    const stockFields = [
      value.tire_width_mm, value.tire_aspect_ratio, value.tire_rim_diameter,
      value.tire_condition, value.shelf_location, value.tire_position,
      value.minimum_quantity,
    ];
    if (stockFields.some((field) => field != null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['item_type'], message: 'service_has_no_stock_fields' });
    }
  }
});

const stockCountItemSchema = z.object({
  stock_id: uuidSchema,
  counted_quantity: z.number().int().nonnegative().max(999999),
  reason: z.enum(['rotina', 'inventario', 'divergencia', 'outro']),
  reason_detail: optionalText(300),
  idempotency_key: z.string().min(8).max(120),
}).strict();

const stockCountSchema = stockCountItemSchema;

const stockCountBatchSchema = z.object({
  batch_id: uuidSchema,
  items: z.array(stockCountItemSchema).min(1).max(200),
}).strict().superRefine((value, ctx) => {
  const ids = value.items.map((item) => item.stock_id);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['items'], message: 'duplicate_stock_id' });
  }
});

const registrationApprovalSchema = z.object({
  average_cost: z.number().nonnegative().max(99999999),
  sale_price: z.number().positive().max(99999999),
  quantity_on_hand: z.number().int().nonnegative().max(999999).nullable().optional(),
  minimum_quantity: z.number().int().nonnegative().max(999999).nullable().optional(),
  supplier_name: optionalText(160),
}).strict();

const rejectionSchema = z.object({
  reason: z.string().trim().min(3).max(500),
}).strict();

function validateParams(request: PartnerAuthedRequest, reply: FastifyReply): boolean {
  if (paramsSchema.safeParse(request.params).success) return true;
  void reply.status(404).send({ error: 'partner_not_found' });
  return false;
}

function validationError(reply: FastifyReply, parsed: { error: z.ZodError }): FastifyReply {
  const issue = parsed.error.issues[0];
  const path = issue?.path.join('.') || 'body';
  return reply.status(400).send({ error: `${path}: ${issue?.message || 'invalid'}` });
}

async function actorLabel(request: PartnerAuthedRequest): Promise<string> {
  const ctx = getPartnerContext(request);
  const identity = await getPartnerSelfIdentity(ctx);
  return identity.display_name || identity.username || `funcionario:${ctx.tokenId}`;
}

function reviewError(reply: FastifyReply, error: unknown): FastifyReply | null {
  if (!(error instanceof OperationStockReviewError)) return null;
  return reply.status(error.status).send({ error: error.code, ...(error.details ?? {}) });
}

export function registerPartnerOperationStockRoutes(fastify: FastifyInstance): void {
  const stockScreen = [requirePartnerAuth, requireScreen('estoque')];
  const ownerOnly = [requirePartnerAuth, requireOwner];

  for (const mime of ['image/jpeg', 'image/png', 'image/webp'] as const) {
    if (!fastify.hasContentTypeParser(mime)) {
      fastify.addContentTypeParser(mime, { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
    }
  }

  fastify.get('/parceiro/:slug/api/operacao/estoque', { preHandler: stockScreen }, async (request: PartnerAuthedRequest, reply) => {
    if (!validateParams(request, reply)) return;
    return reply.status(200).send(await getOperationStock(getPartnerContext(request)));
  });

  fastify.post('/parceiro/:slug/api/operacao/estoque/cadastros', { preHandler: stockScreen }, async (request: PartnerAuthedRequest, reply) => {
    if (!validateParams(request, reply)) return;
    const parsed = itemRegistrationSchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(reply, parsed);
    const ctx = getPartnerContext(request);
    const result = await requestOperationItemRegistration(ctx, await actorLabel(request), parsed.data);
    return reply.status(202).send(result);
  });

  fastify.post('/parceiro/:slug/api/operacao/estoque/contagens', { preHandler: stockScreen }, async (request: PartnerAuthedRequest, reply) => {
    if (!validateParams(request, reply)) return;
    const parsed = stockCountSchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(reply, parsed);
    const ctx = getPartnerContext(request);
    try {
      const result = await requestOperationStockCount(ctx, await actorLabel(request), parsed.data);
      return reply.status(202).send(result);
    } catch (error) {
      if (error instanceof StockUnavailableForCountError) {
        return reply.status(409).send({ error: error.code });
      }
      throw error;
    }
  });

  fastify.post('/parceiro/:slug/api/operacao/estoque/contagens/lote', { preHandler: stockScreen }, async (request: PartnerAuthedRequest, reply) => {
    if (!validateParams(request, reply)) return;
    const parsed = stockCountBatchSchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(reply, parsed);
    const ctx = getPartnerContext(request);
    try {
      const result = await requestOperationStockCountBatch(ctx, await actorLabel(request), parsed.data);
      return reply.status(202).send(result);
    } catch (error) {
      if (error instanceof StockUnavailableForCountError) {
        return reply.status(409).send({ error: error.code });
      }
      throw error;
    }
  });

  fastify.post('/parceiro/:slug/api/operacao/estoque/contagens/:requestId/foto', {
    preHandler: stockScreen,
    bodyLimit: PHOTO_MAX_UPLOAD_BYTES,
  }, async (request: PartnerAuthedRequest, reply) => {
    if (!validateParams(request, reply)) return;
    const requestId = uuidSchema.safeParse((request.params as { requestId?: string }).requestId);
    if (!requestId.success) return reply.status(404).send({ error: 'stock_request_not_found' });
    const ctx = getPartnerContext(request);
    if (rateLimitHit(`stock-count-photo:${ctx.tokenId}:${request.ip}`, 30, 5 * 60_000)) {
      return reply.status(429).send({ error: 'rate_limited' });
    }
    if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
      return reply.status(415).send({ error: 'not_an_image' });
    }
    try {
      const photo = await reencodePhoto(request.body);
      if (photo.bytes.length > 4 * 1024 * 1024) {
        return reply.status(413).send({ error: 'photo_too_large' });
      }
      const status = await attachOperationStockCountEvidence(ctx, requestId.data, {
        bytes: photo.bytes, mime: photo.mime, sizeBytes: photo.bytes.length,
      });
      if (status === 'not_found') return reply.status(404).send({ error: 'stock_request_not_found' });
      return reply.status(200).send({ ok: true, attached: status === 'attached' });
    } catch (error) {
      if (error instanceof PhotoRejectedError) return reply.status(415).send({ error: error.reason });
      throw error;
    }
  });

  fastify.get('/parceiro/:slug/api/operacao/estoque/solicitacoes', { preHandler: ownerOnly }, async (request: PartnerAuthedRequest, reply) => {
    if (!validateParams(request, reply)) return;
    return reply.status(200).send(await getPendingOperationStockRequests(getPartnerContext(request)));
  });

  fastify.get('/parceiro/:slug/api/operacao/estoque/contagens/:requestId/foto', { preHandler: ownerOnly }, async (request: PartnerAuthedRequest, reply) => {
    if (!validateParams(request, reply)) return;
    const requestId = uuidSchema.safeParse((request.params as { requestId?: string }).requestId);
    if (!requestId.success) return reply.status(404).send({ error: 'photo_not_found' });
    const photo = await getOperationStockCountEvidence(getPartnerContext(request), requestId.data);
    if (!photo) return reply.status(404).send({ error: 'photo_not_found' });
    return reply.status(200).header('Content-Type', photo.mime)
      .header('Cache-Control', 'private, max-age=300').send(photo.bytes);
  });

  fastify.post('/parceiro/:slug/api/operacao/estoque/cadastros/:requestId/aprovar', { preHandler: ownerOnly }, async (request: PartnerAuthedRequest, reply) => {
    if (!validateParams(request, reply)) return;
    const requestId = uuidSchema.safeParse((request.params as { requestId?: string }).requestId);
    const body = registrationApprovalSchema.safeParse(request.body ?? {});
    if (!requestId.success) return reply.status(400).send({ error: 'requestId: invalid' });
    if (!body.success) return validationError(reply, body);
    try {
      const result = await approveOperationRegistration(
        getPartnerContext(request), await actorLabel(request), requestId.data, body.data,
      );
      return reply.status(200).send(result);
    } catch (error) {
      return reviewError(reply, error) ?? Promise.reject(error);
    }
  });

  fastify.post('/parceiro/:slug/api/operacao/estoque/contagens/:requestId/aprovar', { preHandler: ownerOnly }, async (request: PartnerAuthedRequest, reply) => {
    if (!validateParams(request, reply)) return;
    const requestId = uuidSchema.safeParse((request.params as { requestId?: string }).requestId);
    if (!requestId.success) return reply.status(400).send({ error: 'requestId: invalid' });
    try {
      const result = await approveOperationStockCount(
        getPartnerContext(request), await actorLabel(request), requestId.data,
      );
      return reply.status(200).send(result);
    } catch (error) {
      return reviewError(reply, error) ?? Promise.reject(error);
    }
  });

  const registerRejectRoute = (kind: 'cadastro' | 'contagem', plural: 'cadastros' | 'contagens') => {
    fastify.post(`/parceiro/:slug/api/operacao/estoque/${plural}/:requestId/rejeitar`, { preHandler: ownerOnly }, async (request: PartnerAuthedRequest, reply) => {
      if (!validateParams(request, reply)) return;
      const requestId = uuidSchema.safeParse((request.params as { requestId?: string }).requestId);
      const body = rejectionSchema.safeParse(request.body ?? {});
      if (!requestId.success) return reply.status(400).send({ error: 'requestId: invalid' });
      if (!body.success) return validationError(reply, body);
      try {
        const result = await rejectOperationStockRequest(
          getPartnerContext(request), await actorLabel(request), kind, requestId.data, body.data.reason,
        );
        return reply.status(200).send(result);
      } catch (error) {
        return reviewError(reply, error) ?? Promise.reject(error);
      }
    });
  };
  registerRejectRoute('cadastro', 'cadastros');
  registerRejectRoute('contagem', 'contagens');
}
