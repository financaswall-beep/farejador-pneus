import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { CaixaAuth } from './queries.js';
import {
  getMatrizOperationStock,
  MatrizOperationStockPriceError,
  setMatrizOperationStockPrice,
} from './operation-stock.js';

type CaixaGuard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export function registerCaixaOperationStockRoutes(
  fastify: FastifyInstance,
  flagGate: CaixaGuard,
  requireCaixaAuth: CaixaGuard,
  requireEstoque: CaixaGuard,
): void {
  const requireOwner: CaixaGuard = async (request, reply) => {
    if ((request as FastifyRequest & { caixa?: CaixaAuth }).caixa?.panelRole !== 'owner') {
      await reply.status(403).send({ error: 'owner_required' });
    }
  };
  fastify.get('/api/caixa/operacao/estoque', {
    preHandler: [flagGate, requireCaixaAuth, requireEstoque],
  }, async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return reply.status(200).send(await getMatrizOperationStock());
  });

  fastify.post('/api/caixa/operacao/estoque/:stockId/preco', {
    preHandler: [flagGate, requireCaixaAuth, requireEstoque, requireOwner],
  }, async (request, reply) => {
    const params = z.object({ stockId: z.string().uuid() }).safeParse(request.params);
    const body = z.object({
      sale_price: z.number().positive().max(99_999_999.99)
        .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-7, 'money_cent_precision'),
      reason: z.string().trim().min(3).max(500),
    }).strict().safeParse(request.body ?? {});
    if (!params.success) return reply.status(404).send({ error: 'stock_not_found' });
    if (!body.success) {
      return reply.status(400).send({ error: body.error.issues[0]?.message ?? 'invalid_body' });
    }
    const auth = (request as FastifyRequest & { caixa?: CaixaAuth }).caixa!;
    try {
      return reply.status(200).send(await setMatrizOperationStockPrice(
        params.data.stockId,
        body.data.sale_price,
        body.data.reason,
        `Caixa: ${auth.displayName} (${auth.username})`.slice(0, 120),
      ));
    } catch (error) {
      if (error instanceof MatrizOperationStockPriceError) {
        return reply.status(error.status).send({ error: error.code });
      }
      throw error;
    }
  });
}
