import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAdminContext, requireAdminAuth } from '../auth.js';
import { dashboardPayload } from './route-helpers.js';
import { getClientesPainel } from './queries-clientes.js';
import { env } from '../../shared/config/env.js';
import { subscribeClientesKanban, type ClientesKanbanEvent } from '../../shared/clientes-kanban.notify.js';
import { registerCustomerIdentityRoutes } from './route-clientes-identity.js';
import { registerCustomerPrivacyRoutes } from './route-clientes-privacy.js';
import { updateCustomerLeadBoard } from './customer-lead-board.js';

const MAX_SSE_PER_IP = 12;
const sseByIp = new Map<string, number>();
const leadParamsSchema = z.object({ conversationId: z.string().uuid() });
const leadBaseSchema = {
  expected_version: z.number().int().min(0),
  idempotency_key: z.string().trim().min(8).max(200),
  reason: z.string().trim().min(3).max(300).optional(),
};
const leadActionSchema = z.discriminatedUnion('action', [
  z.object({ ...leadBaseSchema, action: z.literal('move'),
    lane: z.enum(['novo','atendimento','orcamento','perdido']) }),
  z.object({ ...leadBaseSchema, action: z.literal('archive') }),
  z.object({ ...leadBaseSchema, action: z.literal('restore') }),
]);

function acquireSseSlot(ip: string): (() => void) | null {
  const current = sseByIp.get(ip) ?? 0;
  if (current >= MAX_SSE_PER_IP) return null;
  sseByIp.set(ip, current + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (sseByIp.get(ip) ?? 1) - 1;
    if (next <= 0) sseByIp.delete(ip);
    else sseByIp.set(ip, next);
  };
}

export async function registerPainelClientes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/admin/api/clientes', { preHandler: requireAdminAuth }, async (request, reply) => {
    if (env.MATRIZ_CUSTOMER_IDENTITY && getAdminContext(request).role !== 'owner') {
      return reply.status(403).send({ error: 'admin_owner_required' });
    }
    const data = await getClientesPainel();
    const payload = { ...dashboardPayload(data.rows), partners: data.partners };
    if (!env.MATRIZ_CUSTOMER_IDENTITY) return reply.status(200).send(payload);
    return reply.status(200).send({ ...payload, customer_identity: {
      enabled: true, privacy_enabled: env.MATRIZ_CUSTOMER_PRIVACY, policy: 'owner_full_pii',
    } });
  });

  fastify.patch('/admin/api/clientes/leads/:conversationId', { preHandler: requireAdminAuth }, async (request, reply) => {
    const params = leadParamsSchema.safeParse(request.params);
    const body = leadActionSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.status(400).send({ error: 'invalid_request' });
    try {
      const context = getAdminContext(request);
      const result = await updateCustomerLeadBoard({
        environment: env.FAREJADOR_ENV, conversationId: params.data.conversationId,
        action: body.data.action,
        lane: body.data.action === 'move' ? body.data.lane : undefined,
        expectedVersion: body.data.expected_version,
        actor: context.displayName, reason: body.data.reason,
        idempotencyKey: body.data.idempotency_key,
      });
      return reply.status(200).send(result);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'lead_board_failed';
      if (code === 'lead_conversation_not_found') return reply.status(404).send({ error: code });
      if (['lead_version_conflict','idempotency_conflict','idempotency_incomplete'].includes(code)) {
        return reply.status(409).send({ error: code });
      }
      if (['lead_lane_required','lead_version_invalid','lead_board_state_not_found'].includes(code)) {
        return reply.status(400).send({ error: code });
      }
      request.log.error({ err: error }, 'clientes: falha ao atualizar quadro');
      return reply.status(500).send({ error: 'lead_board_failed' });
    }
  });

  fastify.get('/admin/api/clientes/stream', { preHandler: requireAdminAuth }, async (request, reply) => {
    const releaseSlot = acquireSseSlot(request.ip);
    if (!releaseSlot) {
      return reply.header('Retry-After', '30').status(429).send({ error: 'too_many_connections' });
    }

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    raw.write('retry: 3000\n\n');
    raw.write(': conectado\n\n');

    const send = (event: ClientesKanbanEvent): void => {
      raw.write(`event: kanban\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribe = subscribeClientesKanban(env.FAREJADOR_ENV, send);
    const heartbeat = setInterval(() => raw.write(': hb\n\n'), 25000);
    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      unsubscribe();
      releaseSlot();
    };
    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);
  });

  await registerCustomerIdentityRoutes(fastify);
  await registerCustomerPrivacyRoutes(fastify);
}
