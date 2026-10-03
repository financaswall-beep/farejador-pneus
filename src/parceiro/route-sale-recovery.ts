import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePartnerAuth, requireScreen, getPartnerContext, type PartnerAuthedRequest } from './auth.js';
import { withPartnerContext } from './db.js';

export function registerPartnerSaleRecovery(fastify: FastifyInstance) {
  fastify.get('/parceiro/:slug/api/vendas/por-chave/:key', {
    preHandler: [requirePartnerAuth, requireScreen('vendas')],
  }, async (request: PartnerAuthedRequest, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = z.object({ key: z.string().min(8).max(200) }).safeParse(request.params);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_key' });
    const ctx = getPartnerContext(request);
    const row = await withPartnerContext(ctx.partnerUnitId, async client => {
      const result = await client.query(`SELECT id order_id,status FROM commerce.partner_orders
        WHERE environment=$1 AND unit_id=$2 AND idempotency_key=$3 AND operator_token_id=$4`,
      [ctx.environment, ctx.unitId, parsed.data.key, ctx.tokenId]);
      return result.rows[0];
    });
    return reply.send(row ? { found: true, ...row } : { found: false });
  });
}
