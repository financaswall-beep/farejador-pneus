import type { FastifyInstance, preHandlerHookHandler, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import type { CaixaAuth } from './queries.js';
import { getCaixaMySaleDetail } from './my-sales.js';

export function registerCaixaSaleRecovery(fastify: FastifyInstance, guards: preHandlerHookHandler[]) {
  fastify.get('/api/caixa/vendas/por-chave/:key', { preHandler: guards }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = z.object({ key: z.string().min(8).max(200) }).safeParse(request.params);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_key' });
    const auth = (request as FastifyRequest & { caixa: CaixaAuth }).caixa;
    const result = await pool.query<{ order_id: string; status: string }>(`SELECT id order_id,status
      FROM commerce.orders WHERE environment=$1 AND idempotency_key=$2
        AND seller_collaborator_id=$3 AND source='walkin_balcao'`,
    [env.FAREJADOR_ENV, parsed.data.key, auth.collaboratorId]);
    const row = result.rows[0];
    if (!row) return reply.send({ found: false });
    const receipt = await getCaixaMySaleDetail(env.FAREJADOR_ENV, auth.collaboratorId, row.order_id)
      .catch(() => null);
    return reply.send({ found: true, ...row, receipt });
  });
}
