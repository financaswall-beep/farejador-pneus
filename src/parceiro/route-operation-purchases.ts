import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  getPartnerContext,
  requirePartnerAuth,
  requireScreen,
  type PartnerAuthedRequest,
} from './auth.js';
import { getPartnerSelfIdentity } from './queries.js';
import {
  getOperationPendingPurchases,
  OperationPurchaseReceiptError,
  receiveOperationPurchase,
} from './operation-purchase-receipt.js';

const paramsSchema = z.object({
  slug: z.string().min(1).max(120),
  purchaseId: z.string().uuid().optional(),
});

const receiptSchema = z.object({
  idempotency_key: z.string().min(8).max(120),
  items: z.array(z.object({
    item_id: z.string().uuid(),
    received_quantity: z.number().int().nonnegative().max(999999),
  }).strict()).min(1).max(200),
}).strict().superRefine((value, ctx) => {
  const ids = value.items.map((item) => item.item_id);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['items'], message: 'duplicate_item_id' });
  }
});

function validParams(request: PartnerAuthedRequest, reply: FastifyReply): z.infer<typeof paramsSchema> | null {
  const parsed = paramsSchema.safeParse(request.params);
  if (parsed.success) return parsed.data;
  void reply.status(404).send({ error: 'purchase_not_found' });
  return null;
}

async function actorLabel(request: PartnerAuthedRequest): Promise<string> {
  const ctx = getPartnerContext(request);
  const identity = await getPartnerSelfIdentity(ctx);
  return identity.display_name || identity.username || `funcionario:${ctx.tokenId}`;
}

function receiptError(reply: FastifyReply, error: unknown): FastifyReply | null {
  if (!(error instanceof OperationPurchaseReceiptError)) return null;
  return reply.status(error.status).send({ error: error.code, ...(error.details ?? {}) });
}

export function registerPartnerOperationPurchaseRoutes(fastify: FastifyInstance): void {
  const stockScreen = [requirePartnerAuth, requireScreen('estoque')];

  fastify.get('/parceiro/:slug/api/operacao/compras', {
    preHandler: stockScreen,
  }, async (request: PartnerAuthedRequest, reply) => {
    if (!validParams(request, reply)) return;
    return reply.status(200).send(await getOperationPendingPurchases(getPartnerContext(request)));
  });

  fastify.post('/parceiro/:slug/api/operacao/compras/:purchaseId/receber', {
    preHandler: stockScreen,
  }, async (request: PartnerAuthedRequest, reply) => {
    const params = validParams(request, reply);
    if (!params?.purchaseId) return;
    const body = receiptSchema.safeParse(request.body ?? {});
    if (!body.success) {
      const issue = body.error.issues[0];
      return reply.status(400).send({
        error: `${issue?.path.join('.') || 'body'}: ${issue?.message || 'invalid'}`,
      });
    }
    try {
      const result = await receiveOperationPurchase(
        getPartnerContext(request), await actorLabel(request), params.purchaseId, body.data,
      );
      return reply.status(200).send(result);
    } catch (error) {
      return receiptError(reply, error) ?? Promise.reject(error);
    }
  });
}
