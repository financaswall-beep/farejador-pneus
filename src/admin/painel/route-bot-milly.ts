import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { definirConsultaMilly, lerConsultaMilly } from '../../atendente-v2/milly-negociacao.js';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { getAdminContext, requireAdminOwner } from '../auth.js';
import { canalConsultaMillyDisponivel } from '../dot/events/negotiation-live.js';

const url = '/admin/api/bot/consulta-milly';
const bodySchema = z.object({ ativa: z.boolean() }).strict();

function fluxoDisponivel(): boolean {
  return env.AGENT_V2_WORKER_ENABLED && env.BOT_OUTBOX;
}

async function requireOwnerSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const owner = getAdminContext(request);
  if (owner.authType !== 'session' || !owner.personId) await reply.code(403).send({ error: 'human_owner_required' });
}

async function statusCanal(personId: string): Promise<boolean | null> {
  try {
    return await canalConsultaMillyDisponivel(pool, env.FAREJADOR_ENV, personId);
  } catch {
    return null;
  }
}

export function registerBotMillyRoutes(app: FastifyInstance): void {
  const auth = { preHandler: [requireAdminOwner, requireOwnerSession] };

  app.get(url, auth, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    try {
      const [ativa, canal_disponivel] = await Promise.all([
        lerConsultaMilly(pool, env.FAREJADOR_ENV),
        statusCanal(getAdminContext(request).personId!),
      ]);
      return { ativa, canal_disponivel, fluxo_disponivel: fluxoDisponivel() };
    } catch (err) {
      request.log.warn({ err }, 'falha ao consultar configuração da Milly');
      return reply.code(503).send({ error: 'consulta_milly_indisponivel' });
    }
  });

  app.put(url, { ...auth, bodyLimit: 1024 }, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'configuracao_milly_invalida' });
    try {
      const personId = getAdminContext(request).personId!;
      const ativa = await definirConsultaMilly(pool, env.FAREJADOR_ENV, parsed.data.ativa, personId);
      request.log.info({ ativa, operador: personId }, 'consulta comercial à Milly atualizada');
      return { ativa, fluxo_disponivel: fluxoDisponivel() };
    } catch (err) {
      request.log.error({ err }, 'falha ao alterar configuração da Milly');
      return reply.code(503).send({ error: 'consulta_milly_indisponivel' });
    }
  });
}
