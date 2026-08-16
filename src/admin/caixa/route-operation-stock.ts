import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getMatrizOperationStock } from './operation-stock.js';

type CaixaGuard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export function registerCaixaOperationStockRoutes(
  fastify: FastifyInstance,
  flagGate: CaixaGuard,
  requireCaixaAuth: CaixaGuard,
  requireEstoque: CaixaGuard,
): void {
  fastify.get('/api/caixa/operacao/estoque', {
    preHandler: [flagGate, requireCaixaAuth, requireEstoque],
  }, async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return reply.status(200).send(await getMatrizOperationStock());
  });
}
