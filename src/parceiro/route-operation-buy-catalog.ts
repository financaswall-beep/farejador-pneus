import type { FastifyInstance } from 'fastify';
import { getPartnerContext, requirePartnerAuth, requireScreen, type PartnerAuthedRequest } from './auth.js';
import { getPartnerBuyCatalog } from './operation-buy-catalog.js';
import { z } from 'zod';
import { submitBuyRequest, getBuyRequests } from './operation-buy-requests.js';
import type { PartnerContext } from './auth.js';
import { buyRequestError } from './route-buy-request-errors.js';

export type BuyRequestReceiver = (ctx:PartnerContext,id:string,input:{idempotency_key:string;
  items:Array<{item_id:string;received_quantity:number}>}) => Promise<Record<string,unknown>>;
export function registerPartnerBuyCatalogRoutes(fastify: FastifyInstance, receiveRequest?: BuyRequestReceiver) {
  fastify.get('/parceiro/:slug/api/operacao/comprar', {
    preHandler: [requirePartnerAuth, requireScreen('estoque')],
  }, async (request: PartnerAuthedRequest, reply) => {
    reply.header('Cache-Control', 'no-store');
    return getPartnerBuyCatalog(getPartnerContext(request));
  });
  const key=z.string().trim().min(8).max(100);
  const submit=z.object({idempotency_key:key,items:z.array(z.object({offer_key:z.string().uuid(),
    quantity:z.number().int().min(1).max(999),expected_price_cents:z.number().int().positive().max(99999999999)}).strict()).min(1).max(50)}).strict();
  const receipt=z.object({idempotency_key:key,items:z.array(z.object({item_id:z.string().uuid(),
    received_quantity:z.number().int().min(0).max(999)}).strict()).min(1).max(50)}).strict();
  fastify.get('/parceiro/:slug/api/operacao/comprar/pedidos', {
    preHandler:[requirePartnerAuth,requireScreen('estoque')],
  }, async (request:PartnerAuthedRequest,reply) => {
    reply.header('Cache-Control','no-store');
    try { return await getBuyRequests(getPartnerContext(request)); }
    catch (error) { const e=buyRequestError(error); return reply.code(e.status).send({error:e.error}); }
  });
  fastify.post('/parceiro/:slug/api/operacao/comprar/pedidos', {
    preHandler:[requirePartnerAuth,requireScreen('compras'),requireScreen('estoque')],
  }, async (request:PartnerAuthedRequest,reply) => {
    const parsed=submit.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({error:'invalid_body'});
    try { return reply.code(201).send(await submitBuyRequest(getPartnerContext(request),parsed.data)); }
    catch (error) { const e=buyRequestError(error); return reply.code(e.status).send({error:e.error}); }
  });
  fastify.post('/parceiro/:slug/api/operacao/comprar/pedidos/:id/receber', {
    preHandler:[requirePartnerAuth,requireScreen('compras'),requireScreen('estoque')],
  }, async (request:PartnerAuthedRequest,reply) => {
    const id=z.object({id:z.string().uuid()}).safeParse(request.params),parsed=receipt.safeParse(request.body);
    if (!id.success || !parsed.success) return reply.code(400).send({error:'invalid_body'});
    if (!receiveRequest) return reply.code(503).send({error:'buy_receipt_unavailable'});
    try { return await receiveRequest(getPartnerContext(request),id.data.id,parsed.data); }
    catch (error) { const e=buyRequestError(error); return reply.code(e.status).send({error:e.error}); }
  });
}
