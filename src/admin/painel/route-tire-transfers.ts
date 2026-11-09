import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminAuth, requireAdminOwner } from '../auth.js';
import { mapWriteError, operatorLabel } from './route-helpers.js';
import { transferPlanSchema } from './tire-transfer-plan.js';
import { confirmTransferSchema, confirmTireTransfer, previewTireTransfer, reverseTransferSchema, reverseTireTransfer } from './tire-stock-transfers.js';
import { listTireTransfers, listTransferProducts, tireTransfersReady } from './tire-transfer-read.js';

export async function registerTireTransferRoutes(app: FastifyInstance) {
  const ready = async (_request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    if (!(await tireTransfersReady())) {
      return reply.code(503).send({ error: 'transfer_migration_required' });
    }
  };
  app.get('/admin/api/wholesale/stock-transfers', { preHandler: [requireAdminAuth, ready] }, async (request, reply) => {
    const q = z.object({ lot_id: z.string().uuid().optional(), stock_id: z.string().uuid().optional(),
      page: z.coerce.number().int().min(1).max(100000).default(1) }).strict().safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: 'invalid_query' });
    return listTireTransfers(q.data);
  });
  app.get('/admin/api/wholesale/stock-transfer-products', { preHandler: [requireAdminOwner, ready] }, async (request, reply) => {
    const q = z.object({ search: z.string().trim().max(100).default('') }).strict().safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: 'invalid_query' });
    return listTransferProducts(q.data.search);
  });
  app.post('/admin/api/wholesale/stock-transfers/preview', { preHandler: [requireAdminOwner, ready] }, async (request, reply) => {
    const q = transferPlanSchema.safeParse(request.body);
    if (!q.success) return reply.code(400).send({ error: 'invalid_body' });
    try { return await previewTireTransfer(q.data); } catch (error) { return fail(reply, error); }
  });
  app.post('/admin/api/wholesale/stock-transfers', { preHandler: [requireAdminOwner, ready] }, async (request, reply) => {
    const q = confirmTransferSchema.safeParse(request.body);
    const input = transferPlanSchema.safeParse(q.success ? q.data.input : null);
    if (!q.success || !input.success) return reply.code(400).send({ error: 'invalid_body' });
    try { return reply.code(201).send(await confirmTireTransfer(input.data, q.data.fingerprint, q.data.idempotency_key, operatorLabel(request))); }
    catch (error) { return fail(reply, error); }
  });
  app.post('/admin/api/wholesale/stock-transfers/reverse', { preHandler: [requireAdminOwner, ready] }, async (request, reply) => {
    const q = reverseTransferSchema.safeParse(request.body);
    if (!q.success) return reply.code(400).send({ error: 'invalid_body' });
    try { return await reverseTireTransfer(q.data, operatorLabel(request)); } catch (error) { return fail(reply, error); }
  });
}
function fail(reply: import('fastify').FastifyReply, error: unknown) {
  const code = error instanceof Error ? error.message : '';
  if (code.startsWith('transfer_')) return reply.code(409).send({ error: code });
  const mapped = mapWriteError(error); return reply.code(mapped.status).send({ error: mapped.error });
}
