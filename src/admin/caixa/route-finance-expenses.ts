import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { CaixaAuth } from './queries.js';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/logger.js';
import { createMatrizExpenseSchema } from '../painel/route-schemas.js';
import { reportDate } from '../painel/report-period.js';
import { createMatrizExpense } from '../painel/queries-financeiro-despesas-integridade.js';
import { listMatrizExpenseCategories } from '../painel/queries-despesas-categorias.js';
import { mapWriteError } from '../painel/route-helpers.js';
import { registerExpenseReceiptRoutes } from '../painel/route-expense-receipts.js';
import { expenseReceiptsReady } from '../painel/expense-receipts.js';

type Gate = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
// O contrato e a transação são os mesmos do web; validação civil evita datas normalizadas pelo Postgres.
const schema = createMatrizExpenseSchema.superRefine((body, ctx) => {
  if (!Number.isSafeInteger(Math.round(body.amount * 100)) || Math.abs(body.amount * 100 - Math.round(body.amount * 100)) > 0.000001) {
    ctx.addIssue({ code: 'custom', path: ['amount'], message: 'amount_cent_precision' });
  }
  for (const key of ['due_date', 'document_date', 'competence_month'] as const) {
    if (body[key] && !reportDate.safeParse(body[key]).success) ctx.addIssue({ code: 'custom', path: [key], message: 'invalid_date' });
  }
});

export function registerCaixaFinanceExpenseRoutes(app: FastifyInstance, flag: Gate, auth: Gate, finance: Gate) {
  const guards = [flag, auth, finance, async (request: FastifyRequest, reply: FastifyReply) => {
    if ((request as FastifyRequest & { caixa?: CaixaAuth }).caixa?.panelRole !== 'owner') {
      await reply.code(403).send({ error: 'owner_required' }); return;
    }
    if (!env.MATRIZ_EXPENSES) await reply.code(404).send({ error: 'expenses_disabled' });
  }];
  registerExpenseReceiptRoutes(app, { prefix: '/api/caixa/financeiro-despesas', read: [flag, auth, finance], write: guards,
    actor: request => { const actor = (request as FastifyRequest & { caixa: CaixaAuth }).caixa; return `${actor.displayName} (${actor.username})`.slice(0, 120); } });
  app.get('/api/caixa/financeiro-despesas/categorias', { preHandler: guards }, async (_, reply) => {
    reply.header('Cache-Control', 'no-store');
    try { return { categories: (await listMatrizExpenseCategories()).filter(row => !row.archived),
      receipts_enabled: await expenseReceiptsReady().catch(() => false), receipt_ai_enabled: env.MATRIZ_RECEIPT_AI }; }
    catch (error) {
      logger.error({ err: error }, 'app expense categories unavailable');
      return reply.code(503).send({ error: 'expense_categories_unavailable' });
    }
  });
  app.post('/api/caixa/financeiro-despesas', { preHandler: guards }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    try {
      const actor = (request as FastifyRequest & { caixa: CaixaAuth }).caixa;
      const expense = await createMatrizExpense({ ...parsed.data, created_by: `${actor.displayName} (${actor.username})`.slice(0, 120) });
      return reply.code(201).send({ created: true, expense });
    } catch (error) {
      const mapped = mapWriteError(error);
      logger.error({ err: error }, 'app expense creation failed');
      return reply.code(mapped.status).send({ error: mapped.error });
    }
  });
}
