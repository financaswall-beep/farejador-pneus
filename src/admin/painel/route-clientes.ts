import type { FastifyInstance } from 'fastify';
import { getAdminContext, requireAdminAuth } from '../auth.js';
import { dashboardPayload } from './route-helpers.js';
import { getClientesPainel } from './queries-clientes.js';
import { env } from '../../shared/config/env.js';
import { subscribeClientesKanban, type ClientesKanbanEvent } from '../../shared/clientes-kanban.notify.js';
import { registerCustomerIdentityRoutes } from './route-clientes-identity.js';
import { registerCustomerPrivacyRoutes } from './route-clientes-privacy.js';

const MAX_SSE_PER_IP = 12;
const sseByIp = new Map<string, number>();

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
