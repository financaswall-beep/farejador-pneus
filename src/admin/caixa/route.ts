import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/logger.js';
import {
  rateLimitBlocked,
  rateLimitClear,
  rateLimitHit,
  rateLimitRetryAfterSeconds,
} from '../../shared/rate-limit.js';
import { registerCaixaStaticRoutes } from './route-static.js';
import {
  changeCaixaPassword,
  isCaixaSessionToken,
  revokeCaixaSession,
  validateCaixaSession,
  type CaixaAuth,
} from './queries.js';
import { getCaixaMySaleDetail, getCaixaMySales } from './my-sales.js';
import { createCaixaSale, getCaixaCatalog } from './checkout.js';
import { registerCaixaPhotoRoutes } from './route-photo.js';
import { registerCaixaDeliveryRoutes } from './route-deliveries.js';
import { registerCaixaOperationLoginRoutes } from './route-operation-login.js';
import { getMatrizSimpleFinance } from './simple-finance.js';
import { getMatrizFinanceEntries } from './finance-entries.js';
import { getMatrizFinanceOutputs } from './finance-outputs.js';
import { registerCaixaCommissionRoutes } from './route-commissions.js';

const LOGIN_WINDOW_MS = 5 * 60 * 1000;

const salesQuerySchema = z.object({
  period: z.enum(['today', '7d', '30d']).default('today'),
  search: z.string().trim().max(80).default(''),
  week: z.coerce.number().int().min(-52).max(0).default(0),
});

const catalogQuerySchema = z.object({
  search: z.string().trim().max(80).default(''),
  type: z.enum(['all', 'tire', 'service']).default('all'),
});

const createSaleSchema = z.object({
  customer_name: z.string().trim().min(1).max(200).nullable().optional(),
  customer_phone: z.string().trim().min(1).max(40).nullable().optional(),
  payment_method: z.enum(['pix', 'cartao', 'dinheiro']),
  idempotency_key: z.string().trim().min(8).max(120),
  items: z.array(z.object({
    product_id: z.string().uuid(),
    quantity: z.number().int().positive().max(50),
  })).min(1).max(30),
}).refine((data) => data.items.reduce((sum, item) => sum + item.quantity, 0) <= 100, {
  message: 'sale_quantity_limit',
  path: ['items'],
});

const receiptParamsSchema = z.object({ orderId: z.string().uuid() });

const changePasswordSchema = z.object({
  current_password: z.string().min(1).max(200),
  new_password: z.string().min(12).max(200),
}).refine((data) => data.current_password !== data.new_password, {
  message: 'same_password',
  path: ['new_password'],
});

const simpleFinanceQuerySchema = z.object({
  range: z.enum(['today', '7d', '15d', '30d']).default('30d'),
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
});

type CaixaRequest = FastifyRequest & { caixa?: CaixaAuth };

function bearerOf(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7);
  return isCaixaSessionToken(token) ? token : null;
}

function tooMany(reply: FastifyReply, key: string) {
  return reply.header('Retry-After', String(rateLimitRetryAfterSeconds(key)))
    .status(429).send({ error: 'too_many_attempts' });
}

function checkoutError(error: unknown): { status: number; error: string } {
  if (!(error instanceof Error)) return { status: 500, error: 'internal_server_error' };
  if (error.message === 'caixa_finance_not_ready') {
    return { status: 503, error: error.message };
  }
  if ([
    'walkin_measure_not_found', 'walkin_cost_missing', 'walkin_stock_insufficient',
    'walkin_stock_ambiguous', 'walkin_idempotency_conflict',
    'walkin_product_not_sellable', 'catalog_price_missing', 'catalog_price_changed',
    'seller_collaborator_not_found', 'walkin_unit_not_found',
  ].includes(error.message)) {
    return { status: 409, error: error.message };
  }
  if ([
    'walkin_items_required', 'walkin_idempotency_required', 'walkin_item_invalid',
    'walkin_total_invalid', 'sale_quantity_limit',
  ].includes(error.message)) {
    return { status: 400, error: error.message };
  }
  return { status: 500, error: 'internal_server_error' };
}

export async function registerCaixaRoute(fastify: FastifyInstance): Promise<void> {
  const flagGate = async (_request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!env.MATRIZ_CAIXA_PORTAL) await reply.status(404).send({ error: 'not_found' });
  };
  registerCaixaStaticRoutes(fastify, flagGate);

  const requireCaixaAuth = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = bearerOf(request);
    if (!token) {
      await reply.status(401).send({ error: 'unauthorized' });
      return;
    }
    const auth = await validateCaixaSession(env.FAREJADOR_ENV, token);
    if (!auth) {
      await reply.status(401).send({ error: 'unauthorized' });
      return;
    }
    (request as CaixaRequest).caixa = auth;
  };
  const requireCaixaModule = (module: keyof CaixaAuth['modules']) => async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const auth = (request as CaixaRequest).caixa;
    if (!auth?.modules[module]) await reply.status(403).send({ error: 'forbidden' });
  };
  const requireVendas = requireCaixaModule('vendas');
  const requireEntregas = requireCaixaModule('entregas');
  const requireFinanceiro = requireCaixaModule('financeiro');
  registerCaixaPhotoRoutes(fastify, flagGate, requireCaixaAuth, requireVendas);
  registerCaixaDeliveryRoutes(fastify, flagGate, requireCaixaAuth, requireEntregas);
  registerCaixaOperationLoginRoutes(fastify, flagGate);
  registerCaixaCommissionRoutes(fastify, flagGate, requireCaixaAuth, requireFinanceiro);

  fastify.get('/api/caixa/me', { preHandler: [flagGate, requireCaixaAuth] }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const auth = (request as CaixaRequest).caixa!;
    return reply.status(200).send({
      display_name: auth.displayName,
      username: auth.username,
      role: auth.panelRole ?? auth.job,
      modules: auth.modules,
    });
  });

  fastify.get('/api/caixa/financeiro-simples', {
    preHandler: [flagGate, requireCaixaAuth, requireFinanceiro],
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = simpleFinanceQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_query' });
    try {
      return reply.status(200).send(await getMatrizSimpleFinance(parsed.data.range));
    } catch (error) {
      const code = error instanceof Error ? error.message : 'finance_unavailable';
      logger.error({ err: error }, 'simple matrix finance unavailable');
      return reply.status(503).send({ error: code });
    }
  });

  fastify.get('/api/caixa/financeiro-entradas', {
    preHandler: [flagGate, requireCaixaAuth, requireFinanceiro],
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = simpleFinanceQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_query' });
    try {
      return reply.status(200).send(await getMatrizFinanceEntries(parsed.data.range));
    } catch (error) {
      const code = error instanceof Error ? error.message : 'finance_unavailable';
      logger.error({ err: error }, 'matrix finance entries unavailable');
      return reply.status(503).send({ error: code });
    }
  });

  fastify.get('/api/caixa/financeiro-saidas', {
    preHandler: [flagGate, requireCaixaAuth, requireFinanceiro],
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = simpleFinanceQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_query' });
    try {
      return reply.status(200).send(await getMatrizFinanceOutputs(parsed.data.range));
    } catch (error) {
      const code = error instanceof Error ? error.message : 'finance_unavailable';
      logger.error({ err: error }, 'matrix finance outputs unavailable');
      return reply.status(503).send({ error: code });
    }
  });

  fastify.get('/api/caixa/vendas', { preHandler: [flagGate, requireCaixaAuth, requireVendas] }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = salesQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_query' });
    const auth = (request as CaixaRequest).caixa!;
    const payload = await getCaixaMySales(
      env.FAREJADOR_ENV, auth.collaboratorId, parsed.data.week,
    );
    return reply.status(200).send({ ...payload, operator_name: auth.displayName });
  });

  fastify.get('/api/caixa/catalogo', { preHandler: [flagGate, requireCaixaAuth, requireVendas] }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = catalogQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_query' });
    return reply.status(200).send(await getCaixaCatalog(
      env.FAREJADOR_ENV,
      parsed.data.search,
      parsed.data.type,
    ));
  });

  fastify.post('/api/caixa/vendas', { preHandler: [flagGate, requireCaixaAuth, requireVendas] }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = createSaleSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    const auth = (request as CaixaRequest).caixa!;
    try {
      const result = await createCaixaSale(env.FAREJADOR_ENV, auth, parsed.data);
      const receipt = await getCaixaMySaleDetail(
        env.FAREJADOR_ENV, auth.collaboratorId, result.order_id,
      )
        .catch((error: unknown) => {
          // A venda já foi confirmada atomicamente. Uma falha de leitura do
          // recibo não pode induzir o operador a repetir a cobrança.
          logger.warn({ err: error, orderId: result.order_id }, 'caixa receipt unavailable after sale');
          return null;
        });
      return reply.status(200).send({ ...result, receipt });
    } catch (error) {
      const mapped = checkoutError(error);
      logger.error({ err: error, status: mapped.status }, 'caixa sale registration failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  fastify.get('/api/caixa/vendas/:orderId/recibo', {
    preHandler: [flagGate, requireCaixaAuth, requireVendas],
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = receiptParamsSchema.safeParse(request.params ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_order_id' });
    const auth = (request as CaixaRequest).caixa!;
    const receipt = await getCaixaMySaleDetail(
      env.FAREJADOR_ENV, auth.collaboratorId, parsed.data.orderId,
    );
    if (!receipt) return reply.status(404).send({ error: 'sale_not_found' });
    return reply.status(200).send(receipt);
  });

  fastify.post('/api/caixa/password', { preHandler: [flagGate, requireCaixaAuth] }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const auth = (request as CaixaRequest).caixa!;
    const attemptKey = `caixa-password:${auth.personId}:${request.ip}`;
    if (rateLimitBlocked(attemptKey, 5)) return tooMany(reply, attemptKey);
    const parsed = changePasswordSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    const result = await changeCaixaPassword(
      env.FAREJADOR_ENV,
      auth.personId,
      parsed.data.current_password,
      parsed.data.new_password,
    );
    if (result === 'invalid_current_password') {
      const exceeded = rateLimitHit(attemptKey, 5, LOGIN_WINDOW_MS);
      if (exceeded) return tooMany(reply, attemptKey);
      return reply.status(403).send({ error: result });
    }
    if (result === 'same_password') return reply.status(400).send({ error: result });
    if (result === 'account_not_found') return reply.status(404).send({ error: result });
    rateLimitClear(attemptKey);
    return reply.status(200).send({ ok: true });
  });

  fastify.post('/api/caixa/logout', { preHandler: [flagGate, requireCaixaAuth] }, async (request, reply) => {
    const token = bearerOf(request)!;
    await revokeCaixaSession(env.FAREJADOR_ENV, token);
    reply.header('Cache-Control', 'no-store');
    return reply.status(200).send({ ok: true });
  });
}
