import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { stockOriginError } from '../painel/route-stock-origins.js';
import { stockOriginConfirmationBody } from '../painel/stock-origin-inputs.js';
import { confirmStockOrigin, listStockOriginPendings } from '../painel/stock-origin.js';
import { getMatrizRetiradas } from '../painel/queries-pickups.js';
import { getDeliveryPresentation } from './delivery-presentation.js';
import { getCaixaMySaleDetail } from './my-sales.js';
import { caixaSalesScope } from './sales-access.js';
import type { CaixaAuth } from './queries.js';

type Gate = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
const order = z.object({ channel: z.enum(['vendas','entregas','retiradas']), orderId: z.string().uuid() });
const target = order.extend({ pendingId: z.string().uuid() });

async function canReadOrder(auth: CaixaAuth, { channel, orderId }: z.infer<typeof order>) {
  if (channel === 'entregas') {
    if (!env.MATRIZ_LOGISTICS) return false;
    return (await getDeliveryPresentation(auth, [orderId], env.FAREJADOR_ENV, pool, false)).get(orderId)?.delivery_status === 'pending';
  }
  if (channel === 'retiradas') return (await getMatrizRetiradas(pool, orderId, false)).some(row => row.status === 'open');
  const receipt = await getCaixaMySaleDetail(env.FAREJADOR_ENV, auth.collaboratorId, orderId, pool, caixaSalesScope(auth));
  return Boolean(receipt && receipt.status !== 'cancelled');
}

export function registerCaixaStockOriginRoutes(fastify: FastifyInstance, gates: Gate[]) {
  const base = '/api/caixa/origens/:channel/:orderId';
  const authorize: Gate = async (request, reply) => {
    const parsed = order.safeParse(request.params);
    if (!parsed.success) { await reply.status(400).send({ error: 'stock_origin_invalid' }); return; }
    const auth = (request as FastifyRequest & { caixa: CaixaAuth }).caixa;
    if (!auth.modules[parsed.data.channel]) { await reply.status(403).send({ error: 'forbidden' }); return; }
    if (!await canReadOrder(auth, parsed.data)) await reply.status(404).send({ error: 'stock_origin_not_found' });
  };
  const guarded = { preHandler: [...gates, authorize] };
  fastify.get(base, guarded, async (request, reply) => {
    reply.header('Cache-Control','no-store');
    try { return { rows: await listStockOriginPendings(pool, env.FAREJADOR_ENV, { orderIds: [order.parse(request.params).orderId] }) }; }
    catch (error) { return stockOriginError(reply, error); }
  });
  fastify.post(base + '/:pendingId', guarded, async (request, reply) => {
    const parsed = target.safeParse(request.params);
    const body = stockOriginConfirmationBody.safeParse(request.body);
    if (!parsed.success || !body.success) return reply.status(400).send({ error: 'stock_origin_invalid' });
    const auth = (request as FastifyRequest & { caixa: CaixaAuth }).caixa;
    reply.header('Cache-Control','no-store');
    try {
      return await confirmStockOrigin(pool, env.FAREJADOR_ENV, { ...body.data, pending_id: parsed.data.pendingId },
        `Caixa: ${auth.displayName} (${auth.username})`.slice(0,120), parsed.data.orderId);
    } catch (error) { return stockOriginError(reply, error); }
  });
}
