// Obra 300 (2026-07-05): fatia da PORTARIA da matriz — fiado do atacado + últimas vendas + cancelar.
// VERBATIM das linhas 655-719 do route.ts pré-obra (corpo de registerPainelRoute).
// Registrada por ./route.js (porta de entrada) na ordem original.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminAuth } from '../auth.js';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/logger.js';
import { cancelWholesaleSale, getWholesaleFinance, listWholesaleSales, settleWholesaleOrderPayment, settleWholesalePurchasePayment } from './queries.js';
import { dashboardPayload, mapWriteError, operatorLabel } from './route-helpers.js';
import { cancelWholesaleSaleSchema, settleWholesaleFinanceSchema } from './route-schemas.js';

export async function registerPainelFiado(fastify: FastifyInstance): Promise<void> {
  fastify.get('/admin/api/wholesale/finance', { preHandler: requireAdminAuth }, async (_request, reply) => {
    if (!env.WHOLESALE_FINANCE) {
      return reply.status(200).send({ ...dashboardPayload([]), enabled: false });
    }
    return reply.status(200).send({ ...dashboardPayload([]), enabled: true, ...(await getWholesaleFinance()) });
  });

  // Últimas vendas de atacado (vivas e canceladas — trilha visível). É de onde se cancela.
  fastify.get('/admin/api/wholesale/sales', { preHandler: requireAdminAuth }, async (_request, reply) => {
    return reply.status(200).send(dashboardPayload(await listWholesaleSales()));
  });

  // CANCELA uma venda de atacado (0116): confirmed → cancelled + trilha + devolve estoque.
  fastify.post('/admin/api/wholesale/sales/cancel', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = cancelWholesaleSaleSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const result = await cancelWholesaleSale({
        order_id: parsed.data.order_id,
        reason: parsed.data.reason ?? null,
        environment: env.FAREJADOR_ENV,
        idempotency_key: parsed.data.idempotency_key,
        cancelled_by: operatorLabel(request),
      });
      return reply.status(200).send({ cancelled: true, ...result });
    } catch (err) {
      if (err instanceof Error && err.message === 'sale_not_found') {
        return reply.status(404).send({ error: 'sale_not_found' });
      }
      if (err instanceof Error && err.message === 'sale_already_cancelled') {
        return reply.status(409).send({ error: 'sale_already_cancelled' });
      }
      if (err instanceof Error && err.message.startsWith('sale_stock_history_missing:')) {
        let items: Array<{ measure: string; quantity: number }> = [];
        try { items = JSON.parse(err.message.slice('sale_stock_history_missing:'.length)); } catch { /* vazio */ }
        return reply.status(409).send({ error: 'sale_stock_history_missing', items });
      }
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel wholesale sale cancel failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // Quita um fiado. Replay devolve o resultado original; nova operação após pago dá 404.
  fastify.post('/admin/api/wholesale/finance/settle', { preHandler: requireAdminAuth }, async (request, reply) => {
    if (!env.WHOLESALE_FINANCE) return reply.status(404).send({ error: 'finance_disabled' });
    const parsed = settleWholesaleFinanceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const result = parsed.data.kind === 'sale'
        ? await settleWholesaleOrderPayment(parsed.data.id, env.FAREJADOR_ENV, undefined,
          { idempotency_key: parsed.data.idempotency_key, actor_label: operatorLabel(request) })
        : await settleWholesalePurchasePayment(parsed.data.id, env.FAREJADOR_ENV, undefined,
          { idempotency_key: parsed.data.idempotency_key, actor_label: operatorLabel(request) });
      return reply.status(200).send({ settled: true, ...result });
    } catch (err) {
      if (err instanceof Error && (err.message === 'receivable_not_found' || err.message === 'payable_not_found')) {
        return reply.status(404).send({ error: err.message });
      }
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel wholesale finance settle failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // ── MATRIZ — FINANCEIRO: VISÃO CONSOLIDADA (Onda 1, SÓ leitura) ──
  // A tela Financeiro inteira num GET: consolidado do mês (3 pernas − despesas),
  // a receber/a pagar juntos e indicadores. SEM flag própria — cada fatia respeita
  // a flag da sua fonte (fiado/comissão/despesas) e vem null com ela off.
}
