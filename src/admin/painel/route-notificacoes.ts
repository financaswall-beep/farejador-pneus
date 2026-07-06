// SINO da matriz (2026-07-06): rota do agregador de notificações reais.
// Registrada por ./route.js (porta de entrada). Admin-only — o sino é do dono.
import type { FastifyInstance } from 'fastify';
import { requireAdminAuth } from '../auth.js';
import { logger } from '../../shared/logger.js';
import { getMatrizNotificacoes } from './queries.js';

export async function registerPainelNotificacoes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/admin/api/matriz/notificacoes', { preHandler: requireAdminAuth }, async (_request, reply) => {
    try {
      return reply.status(200).send(await getMatrizNotificacoes());
    } catch (err) {
      logger.error({ err }, 'painel notificacoes failed');
      return reply.status(500).send({ error: 'internal_error' });
    }
  });
}
