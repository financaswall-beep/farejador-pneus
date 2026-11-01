import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminAuth, requireAdminOwner, getAdminContext } from '../auth.js';
import { env } from '../../shared/config/env.js';
import { mapWriteError, operatorLabel } from './route-helpers.js';
import { createPurchaseGroup, changePurchaseGroup, linkPurchaseGroup } from './queries-purchase-groups-write.js';
import { listPurchaseGroups, getPurchaseGroup, eligiblePurchaseGroupExpenses, purchaseGroupForPurchase } from './queries-purchase-groups.js';

const key = z.string().trim().min(8).max(200);
const uuid = z.string().uuid();
const name = z.string().trim().min(2).max(120);
const notes = z.string().max(2000).nullable().optional();
const params = z.object({ id: uuid });
const pagination = z.object({ page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50), status: z.enum(['open', 'closed']).optional() });

export function purchaseGroupError(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (['purchase_group_not_found', 'purchase_not_found', 'expense_not_found', 'purchase_group_link_not_found'].includes(message)) return { status: 404, error: message };
  if (message === 'purchase_group_name_invalid') return { status: 400, error: message };
  if (['purchase_group_closed', 'purchase_group_not_empty', 'purchase_already_grouped',
    'expense_already_grouped', 'purchase_order_split_across_groups', 'expense_owned_by_other_module',
    'purchase_cancelled'].includes(message)) return { status: 409, error: message };
  return mapWriteError(error);
}

export async function registerPurchaseGroupRoutes(fastify: FastifyInstance) {
  const prefix = '/admin/api/wholesale/purchase-groups';
  fastify.get(prefix + '/by-purchase/:id', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = params.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_id' });
    return { group: await purchaseGroupForPurchase(parsed.data.id) };
  });
  fastify.get(prefix, { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = pagination.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    return listPurchaseGroups(env.FAREJADOR_ENV, undefined, parsed.data);
  });
  fastify.get(prefix + '/eligible-expenses', { preHandler: requireAdminOwner }, async (request, reply) => {
    const parsed = pagination.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });
    return { rows: await eligiblePurchaseGroupExpenses(undefined, undefined, parsed.data.page) };
  });
  fastify.get(prefix + '/:id', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = params.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_id' });
    try {
      const data = await getPurchaseGroup(parsed.data.id);
      const context = getAdminContext(request);
      const payments = context.role === 'owner' || (context.modules ?? []).includes('financeiro');
      if (!payments) {
        for (const row of data.purchases) {
          delete row.payment_status; delete row.paid_at; delete row.due_date; delete row.payment_method; delete row.installments;
        }
        for (const row of data.expenses) { delete row.payment_status; delete row.paid_at; delete row.due_date; }
      }
      return { ...data, can_view_payments: payments };
    } catch (error) { const mapped = purchaseGroupError(error); return reply.code(mapped.status).send({ error: mapped.error }); }
  });
  fastify.post(prefix, { preHandler: requireAdminOwner }, async (request, reply) => {
    const parsed = z.object({ name, notes, idempotency_key: key }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    try { return reply.code(201).send(await createPurchaseGroup({ ...parsed.data, actor: operatorLabel(request) })); }
    catch (error) { const mapped = purchaseGroupError(error); return reply.code(mapped.status).send({ error: mapped.error }); }
  });
  fastify.post(prefix + '/:id/action', { preHandler: requireAdminOwner }, async (request, reply) => {
    const id = params.safeParse(request.params);
    const parsed = z.object({ action: z.enum(['rename', 'close', 'reopen', 'delete']), name: name.optional(), notes, idempotency_key: key }).safeParse(request.body);
    if (!id.success || !parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    try { return await changePurchaseGroup({ ...parsed.data, group_id: id.data.id, actor: operatorLabel(request) }); }
    catch (error) { const mapped = purchaseGroupError(error); return reply.code(mapped.status).send({ error: mapped.error }); }
  });
  fastify.post(prefix + '/:id/link', { preHandler: requireAdminOwner }, async (request, reply) => {
    const id = params.safeParse(request.params);
    const parsed = z.object({ kind: z.enum(['purchase', 'expense']), record_id: uuid,
      unlink: z.boolean().optional(), idempotency_key: key }).safeParse(request.body);
    if (!id.success || !parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    try { return await linkPurchaseGroup({ ...parsed.data, group_id: id.data.id, actor: operatorLabel(request) }); }
    catch (error) { const mapped = purchaseGroupError(error); return reply.code(mapped.status).send({ error: mapped.error }); }
  });
}
