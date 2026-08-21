// Obra 300 (2026-07-05): fatia da PORTARIA da matriz — visão do financeiro + despesas (0120).
// VERBATIM das linhas 720-795 do route.ts pré-obra (corpo de registerPainelRoute).
// Registrada por ./route.js (porta de entrada) na ordem original.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminAuth, requireAdminOwner } from '../auth.js';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/logger.js';
import { archiveMatrizExpenseCategory, createMatrizExpense, createMatrizExpenseCategory, getMatrizExpenses, getMatrizFinanceiroVisao, listMatrizExpenseCategories, removeMatrizExpense, settleMatrizExpense } from './queries.js';
import { dashboardPayload, mapWriteError, operatorLabel } from './route-helpers.js';
import { createMatrizExpenseSchema, matrizExpenseCategoryArchiveSchema, matrizExpenseCategoryCreateSchema, matrizExpenseIdSchema, matrizExpenseRemoveSchema, matrizExpensesQuerySchema } from './route-schemas.js';
import { registerPainelFinanceiroLedger } from './route-financeiro-ledger.js';
import { MatrizCentralLedgerUnavailableError } from './queries-financeiro-read-switch.js';

export async function registerPainelFinanceiro(fastify: FastifyInstance): Promise<void> {
  await registerPainelFinanceiroLedger(fastify);
  fastify.get('/admin/api/matriz/financeiro', { preHandler: requireAdminAuth }, async (_request, reply) => {
    try {
      return reply.status(200).send({
        ...dashboardPayload([]), ...(await getMatrizFinanceiroVisao()),
      });
    } catch (error) {
      if (error instanceof MatrizCentralLedgerUnavailableError) {
        logger.error(
          { reason: error.reason },
          'painel financeiro: livro central indisponivel; legado nao sera usado',
        );
        return reply.status(503).send({
          error: 'central_ledger_unavailable',
          reason: error.reason,
        });
      }
      throw error;
    }
  });

  // ── MATRIZ — DESPESAS GERAIS (0120, flag MATRIZ_EXPENSES): Fase A do livro-caixa ──
  // A perna de SAÍDA que faltava (aluguel/funcionário/combustível/frete/manutenção).
  // Admin-only + flag (off = enabled:false, a UI se esconde — padrão 0115/0118).

  // Resumo: a pagar (vencidos primeiro) + pago no mês + a lista. 0130: ?mes=YYYY-MM
  // e ?categoria=slug viram EXTRATO DO PERÍODO (soma própria — mata a lista infinita);
  // o payload leva as modalidades (form + rótulos) pro front não ter lista chumbada.
  fastify.get('/admin/api/matriz/despesas', { preHandler: requireAdminAuth }, async (request, reply) => {
    if (!env.MATRIZ_EXPENSES) {
      return reply.status(200).send({ ...dashboardPayload([]), enabled: false });
    }
    const q = matrizExpensesQuerySchema.safeParse(request.query ?? {});
    if (!q.success) {
      return reply.status(400).send({ error: q.error.issues[0]?.message ?? 'invalid_query' });
    }
    const [resumo, categorias] = await Promise.all([
      getMatrizExpenses(undefined, undefined, { month: q.data.mes, category: q.data.categoria }),
      listMatrizExpenseCategories(),
    ]);
    return reply.status(200).send({ ...dashboardPayload([]), enabled: true, ...resumo, categorias });
  });

  // 0130: cadastrar MODALIDADE nova ("Pedágio", "Alimentação"…). Nome já ativo → 409;
  // nome arquivado → REATIVA (o "criei de novo" desfaz o arquivar).
  fastify.post('/admin/api/matriz/despesas/categorias', { preHandler: requireAdminOwner }, async (request, reply) => {
    if (!env.MATRIZ_EXPENSES) return reply.status(404).send({ error: 'expenses_disabled' });
    const parsed = matrizExpenseCategoryCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const result = await createMatrizExpenseCategory({
        label: parsed.data.label,
        environment: env.FAREJADOR_ENV,
        created_by: operatorLabel(request),
      });
      return reply.status(201).send({ created: true, ...result });
    } catch (err) {
      if (err instanceof Error && err.message === 'category_exists') {
        return reply.status(409).send({ error: 'category_exists' });
      }
      if (err instanceof Error && err.message === 'category_label_invalid') {
        return reply.status(400).send({ error: 'category_label_invalid' });
      }
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel matriz expense category create failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // 0130: arquivar modalidade CUSTOM (fábrica não arquiva; despesa antiga fica íntegra).
  fastify.post('/admin/api/matriz/despesas/categorias/arquivar', { preHandler: requireAdminOwner }, async (request, reply) => {
    if (!env.MATRIZ_EXPENSES) return reply.status(404).send({ error: 'expenses_disabled' });
    const parsed = matrizExpenseCategoryArchiveSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const result = await archiveMatrizExpenseCategory(parsed.data.slug, env.FAREJADOR_ENV);
      return reply.status(200).send({ archived: true, ...result });
    } catch (err) {
      if (err instanceof Error && err.message === 'category_not_archivable') {
        return reply.status(400).send({ error: 'category_not_archivable' });
      }
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel matriz expense category archive failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // Lança despesa (à vista nasce paga; a pagar nasce pending com vencimento opcional).
  fastify.post('/admin/api/matriz/despesas', { preHandler: requireAdminOwner }, async (request, reply) => {
    if (!env.MATRIZ_EXPENSES) return reply.status(404).send({ error: 'expenses_disabled' });
    const parsed = createMatrizExpenseSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const result = await createMatrizExpense({
        ...parsed.data,
        created_by: operatorLabel(request),
      });
      return reply.status(201).send({ created: true, ...result });
    } catch (err) {
      // 0130: modalidade inexistente/arquivada — erro do usuário, não 500.
      if (err instanceof Error && err.message === 'category_invalid') {
        return reply.status(400).send({ error: 'category_invalid' });
      }
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel matriz expense create failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // Quita despesa. Replay devolve o resultado original sem sobrescrever paid_at.
  fastify.post('/admin/api/matriz/despesas/settle', { preHandler: requireAdminOwner }, async (request, reply) => {
    if (!env.MATRIZ_EXPENSES) return reply.status(404).send({ error: 'expenses_disabled' });
    const parsed = matrizExpenseIdSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const result = await settleMatrizExpense(parsed.data.id, env.FAREJADOR_ENV, undefined,
        {
          idempotency_key: parsed.data.idempotency_key, actor_label: operatorLabel(request),
          paid_at: parsed.data.paid_at, payment_method: parsed.data.payment_method,
          cash_account: parsed.data.cash_account, note: parsed.data.note,
        });
      return reply.status(200).send({ settled: true, ...result });
    } catch (err) {
      if (err instanceof Error && err.message === 'expense_not_found') {
        return reply.status(404).send({ error: 'expense_not_found' });
      }
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel matriz expense settle failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // REMOVE despesa lançada errada (soft delete — trilha preservada).
  fastify.post('/admin/api/matriz/despesas/remove', { preHandler: requireAdminOwner }, async (request, reply) => {
    if (!env.MATRIZ_EXPENSES) return reply.status(404).send({ error: 'expenses_disabled' });
    const parsed = matrizExpenseRemoveSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const result = await removeMatrizExpense(parsed.data.id, env.FAREJADOR_ENV, undefined,
        { idempotency_key: parsed.data.idempotency_key, actor_label: operatorLabel(request),
          reason: parsed.data.reason });
      return reply.status(200).send({ removed: true, ...result });
    } catch (err) {
      if (err instanceof Error && err.message === 'expense_not_found') {
        return reply.status(404).send({ error: 'expense_not_found' });
      }
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel matriz expense remove failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

}
