import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { CaixaAuth } from './queries.js';
import { env } from '../../shared/config/env.js';
import { listPurchaseGroups, getPurchaseGroup, eligiblePurchaseGroupExpenses, purchaseGroupForPurchase } from '../painel/queries-purchase-groups.js';
import { createPurchaseGroup, changePurchaseGroup, linkPurchaseGroup } from '../painel/queries-purchase-groups-write.js';
import { purchaseGroupReceipts } from '../painel/purchase-group-receipts.js';
import { mapWriteError } from '../painel/route-helpers.js';

type Guard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
const uuid = z.string().uuid(), key = z.string().trim().min(8).max(200), name = z.string().trim().min(2).max(120);
const params = z.object({ id: uuid }), notes = z.string().max(2000).nullable().optional();
const page = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(50), status: z.enum(['open', 'closed']).optional() });

/** Mesmos serviços e transações do web. Recebe os guardas de proprietário de Compras. */
export function registerCaixaPurchaseGroupRoutes(app: FastifyInstance, guards: { preHandler: Guard[] }) {
  const base = '/api/caixa/operacao/compras/viagens';
  const options = { preHandler: [...guards.preHandler, async (_: FastifyRequest, reply: FastifyReply) => { reply.header('Cache-Control', 'no-store'); }] };
  const actor = (request: FastifyRequest) => {
    const auth = (request as FastifyRequest & { caixa: CaixaAuth }).caixa;
    return `Caixa: ${auth.displayName} (${auth.username})`.slice(0, 120);
  };
  const fail = (error: unknown, reply: FastifyReply) => {
    const mapped = mapWriteError(error); return reply.code(mapped.status).send({ error: mapped.error });
  };
  app.get(base, options, async (request, reply) => {
    const q = page.safeParse(request.query); if (!q.success) return reply.code(400).send({ error: 'invalid_query' });
    return listPurchaseGroups(env.FAREJADOR_ENV, undefined, q.data);
  });
  app.get(base + '/elegiveis', options, async (request, reply) => {
    const q = page.safeParse(request.query); if (!q.success) return reply.code(400).send({ error: 'invalid_query' });
    return { rows: await eligiblePurchaseGroupExpenses(env.FAREJADOR_ENV, undefined, q.data.page) };
  });
  app.get(base + '/da-compra/:id', options, async (request, reply) => {
    const p = params.safeParse(request.params); if (!p.success) return reply.code(400).send({ error: 'invalid_id' });
    return { group: await purchaseGroupForPurchase(p.data.id, env.FAREJADOR_ENV) };
  });
  app.get(base + '/:id', options, async (request, reply) => {
    const p = params.safeParse(request.params); if (!p.success) return reply.code(400).send({ error: 'invalid_id' });
    try {
      const data = await getPurchaseGroup(p.data.id, env.FAREJADOR_ENV);
      const receipts = await purchaseGroupReceipts(data.expenses.map(e => e.id), env.FAREJADOR_ENV);
      return { ...data, can_view_payments: true, expenses: data.expenses.map(e => ({ ...e, receipt_id: receipts.find(r => r.expense_id === e.id)?.receipt_id ?? null })) };
    } catch (error) { return fail(error, reply); }
  });
  app.post(base, options, async (request, reply) => {
    const body = z.object({ name, notes, idempotency_key: key }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
    try { return reply.code(201).send(await createPurchaseGroup({ ...body.data, environment: env.FAREJADOR_ENV, actor: actor(request) })); }
    catch (error) { return fail(error, reply); }
  });
  app.post(base + '/:id/acao', options, async (request, reply) => {
    const p = params.safeParse(request.params);
    const body = z.object({ action: z.enum(['rename', 'close', 'reopen', 'delete']), name: name.optional(), notes, idempotency_key: key })
      .refine(b => b.action !== 'rename' || Boolean(b.name), 'name_required').safeParse(request.body);
    if (!p.success || !body.success) return reply.code(400).send({ error: 'invalid_body' });
    try { return await changePurchaseGroup({ ...body.data, group_id: p.data.id, environment: env.FAREJADOR_ENV, actor: actor(request) }); }
    catch (error) { return fail(error, reply); }
  });
  app.post(base + '/:id/vinculo', options, async (request, reply) => {
    const p = params.safeParse(request.params);
    const body = z.object({ kind: z.enum(['purchase', 'expense']), record_id: uuid, unlink: z.boolean().optional(), idempotency_key: key }).safeParse(request.body);
    if (!p.success || !body.success) return reply.code(400).send({ error: 'invalid_body' });
    try { return await linkPurchaseGroup({ ...body.data, group_id: p.data.id, environment: env.FAREJADOR_ENV, actor: actor(request) }); }
    catch (error) { return fail(error, reply); }
  });
}
