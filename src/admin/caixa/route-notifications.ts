import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '../../shared/logger.js';
import type { CaixaAuth } from './queries.js';
import { getMatrizOperationNotifications } from './operation-notifications.js';

type Hook = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
type CaixaRequest = FastifyRequest & { caixa?: CaixaAuth };

export function registerCaixaNotificationRoutes(
  fastify: FastifyInstance,
  flagGate: Hook,
  requireCaixaAuth: Hook,
): void {
  fastify.get('/api/caixa/notificacoes', {
    preHandler: [flagGate, requireCaixaAuth],
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const auth = (request as CaixaRequest).caixa!;
    try {
      return reply.status(200).send(await getMatrizOperationNotifications(auth));
    } catch (error) {
      logger.error({ err: error }, 'matrix operation notifications unavailable');
      return reply.status(503).send({ error: 'notifications_unavailable' });
    }
  });
}
