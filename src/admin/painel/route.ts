import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAdminAuth } from '../auth.js';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/logger.js';
import {
  cancelManualOrder,
  getPainelOperacao,
  getPainelPedidos,
  getPainelProdutos,
  getPainelRede,
  getPainelResumo,
  getPainelShadow,
  registerManualOrder,
  registerWalkinOrder,
  reviewHumanBot,
} from './queries.js';

const publicDir = path.join(process.cwd(), 'painel', 'public');

const limitQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const redeQuerySchema = z.object({
  period: z.enum(['today', '7d', '30d', 'month']).default('month'),
});

const orderItemSchema = z.object({
  product_id: z.string().uuid(),
  quantity: z.number().int().positive(),
  unit_price: z.number().nonnegative(),
  discount_amount: z.number().nonnegative().optional(),
});

// S6 da auditoria 2026-05-21: pedido de entrega exige endereco.
const requireDeliveryAddress = (data: { fulfillment_mode: string; delivery_address?: string | null }): boolean =>
  data.fulfillment_mode !== 'delivery' || !!(data.delivery_address && data.delivery_address.trim().length > 0);
const deliveryAddressRefineOpts = {
  message: 'delivery_address obrigatorio quando fulfillment_mode=delivery',
  path: ['delivery_address'] as (string | number)[],
};

const registerManualOrderSchema = z.object({
  environment: z.enum(['prod', 'test']).optional(),
  contact_id: z.string().uuid().optional(),
  conversation_id: z.string().uuid(),
  draft_id: z.string().uuid().nullable().optional(),
  unit_id: z.string().uuid().nullable().optional(),
  items: z.array(orderItemSchema).min(1),
  payment_method: z.string().min(1).nullable(),
  fulfillment_mode: z.enum(['delivery', 'pickup']),
  delivery_address: z.string().min(1).nullable().optional(),
  idempotency_key: z.string().min(8),
  source_tag: z.enum(['chatwoot_com_bot', 'chatwoot_sem_bot']).nullable().optional(),
}).refine(requireDeliveryAddress, deliveryAddressRefineOpts);

const registerWalkinOrderSchema = z.object({
  environment: z.enum(['prod', 'test']).optional(),
  customer_name: z.string().min(1).max(200).nullable().optional(),
  customer_phone: z.string().min(1).max(40).nullable().optional(),
  unit_id: z.string().uuid().nullable().optional(),
  items: z.array(orderItemSchema).min(1),
  payment_method: z.string().min(1).nullable(),
  fulfillment_mode: z.enum(['delivery', 'pickup']),
  delivery_address: z.string().min(1).nullable().optional(),
  idempotency_key: z.string().min(8),
  source_tag: z.enum(['walkin_balcao', 'walkin_telefone', 'walkin_outro']),
}).refine(requireDeliveryAddress, deliveryAddressRefineOpts);

const cancelParamsSchema = z.object({
  order_id: z.string().uuid(),
});

const cancelBodySchema = z.object({
  reason: z.string().min(1).max(500),
});

const reviewBodySchema = z.object({
  environment: z.enum(['prod', 'test']).optional(),
  turn_id: z.string().uuid(),
  verdict: z.enum(['human_better', 'bot_better', 'equivalent', 'bot_unsure', 'skip']),
  notes: z.string().max(2000).nullable().optional(),
});

function operatorLabel(headers: Record<string, unknown>): string {
  const raw = headers['x-operator-label'];
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return raw.trim().slice(0, 120);
  }
  return 'admin';
}

async function sendStatic(reply: FastifyReply, file: string, type: string) {
  const content = await readFile(path.join(publicDir, file));
  return reply.header('Content-Type', type).send(content);
}

function mapWriteError(err: unknown): { status: number; error: string } {
  if (!(err instanceof Error)) {
    return { status: 500, error: 'internal_server_error' };
  }

  if (err.message.includes('conversation_contact_not_found')) {
    return { status: 400, error: 'conversation_contact_not_found' };
  }

  if (
    err.message.includes('Pedido ja registrado') ||
    err.message.includes('duplicate key') ||
    err.message.includes('unique')
  ) {
    return { status: 409, error: 'already_registered' };
  }

  return { status: 500, error: 'internal_server_error' };
}

function dashboardPayload(rows: unknown[]) {
  const chatwootBaseUrl = env.CHATWOOT_API_BASE_URL?.replace(/\/api\/v1\/?$/, '').replace(/\/$/, '') ?? null;
  return {
    environment: env.FAREJADOR_ENV,
    chatwoot_account_id: env.CHATWOOT_ACCOUNT_ID ?? null,
    chatwoot_base_url: chatwootBaseUrl,
    agent_v2_worker_enabled: env.AGENT_V2_WORKER_ENABLED,
    rows,
  };
}

export async function registerPainelRoute(fastify: FastifyInstance): Promise<void> {
  fastify.get('/admin/painel', async (_request, reply) => sendStatic(reply, 'index.html', 'text/html; charset=utf-8'));
  fastify.get('/admin/painel/', async (_request, reply) => sendStatic(reply, 'index.html', 'text/html; charset=utf-8'));
  fastify.get('/admin/painel/app.js', async (_request, reply) => sendStatic(reply, 'app.js', 'text/javascript; charset=utf-8'));
  fastify.get('/admin/painel/rede-fallback.js', async (_request, reply) => sendStatic(reply, 'rede-fallback.js', 'text/javascript; charset=utf-8'));
  fastify.get('/admin/painel/style.css', async (_request, reply) => sendStatic(reply, 'style.css', 'text/css; charset=utf-8'));

  fastify.get('/admin/api/dashboard/resumo', { preHandler: requireAdminAuth }, async (_request, reply) => {
    return reply.status(200).send(dashboardPayload(await getPainelResumo()));
  });

  fastify.get('/admin/api/dashboard/operacao', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = limitQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_query' });
    return reply.status(200).send(dashboardPayload(await getPainelOperacao(parsed.data.limit)));
  });

  fastify.get('/admin/api/dashboard/shadow', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = limitQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_query' });
    return reply.status(200).send(dashboardPayload(await getPainelShadow(parsed.data.limit)));
  });

  fastify.get('/admin/api/dashboard/pedidos', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = limitQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_query' });
    return reply.status(200).send(dashboardPayload(await getPainelPedidos(parsed.data.limit)));
  });

  fastify.get('/admin/api/dashboard/produtos', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = limitQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_query' });
    return reply.status(200).send(dashboardPayload(await getPainelProdutos(parsed.data.limit)));
  });

  // Dados consolidados da Rede (parceiros, vendas, estoque, despesas, etc).
  // Lê de network.partner_unit_summary que agrega tudo do parceiro pra admin ver.
  fastify.get('/admin/api/dashboard/rede', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = redeQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_query' });
    return reply.status(200).send(dashboardPayload(await getPainelRede(parsed.data.period)));
  });

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

  fastify.post('/admin/api/shadow/review', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = reviewBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }

    try {
      return reply.status(200).send(await reviewHumanBot({
        ...parsed.data,
        reviewer_label: operatorLabel(request.headers),
      }));
    } catch (err) {
      logger.error({ err }, 'painel human-bot review failed');
      return reply.status(500).send({ error: 'internal_server_error' });
    }
  });
}
