// Obra 300 (2026-07-05): fatia da PORTARIA da matriz — fornecedores + compras.
// VERBATIM das linhas 600-654 do route.ts pré-obra (corpo de registerPainelRoute).
// Registrada por ./route.js (porta de entrada) na ordem original.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminAuth } from '../auth.js';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/logger.js';
import { archiveWholesaleSupplier, cancelWholesalePurchase, confirmWholesalePurchase, getWholesalePriceReport, getWholesalePurchaseReport, getWholesaleSupplierInsights, getWholesaleSupplierMeasureBreakdown, getWholesaleSupplierRanking, listWholesalePurchases, listWholesaleSuppliers, registerWholesalePurchase, registerWholesaleSupplier } from './queries.js';
import { dashboardPayload, mapWriteError, operatorLabel } from './route-helpers.js';
import { archiveWholesaleSupplierSchema, cancelWholesalePurchaseSchema, confirmWholesalePurchaseSchema, registerPurchaseSchema, registerSupplierSchema } from './route-schemas.js';

const purchaseReportQuerySchema = z.object({
  period: z.enum(['30d', '90d', 'year', 'all']).default('30d'),
  status: z.enum(['all', 'pending', 'confirmed', 'cancelled']).default('all'),
  payment: z.enum(['all', 'paid', 'pending']).default('all'),
  search: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  page_size: z.coerce.number().int().min(4).max(100).default(10),
});

const priceReportQuerySchema = z.object({
  period: z.enum(['30d', '90d', 'year', 'all']).default('90d'),
  supplier_id: z.string().uuid().optional(),
  search: z.string().trim().max(80).optional(),
});

export async function registerPainelFornecedores(fastify: FastifyInstance): Promise<void> {
  fastify.get('/admin/api/wholesale/suppliers', { preHandler: requireAdminAuth }, async (_request, reply) => {
    return reply.status(200).send(dashboardPayload(await listWholesaleSuppliers()));
  });

  // Cadastra um fornecedor (nome + telefone).
  fastify.post('/admin/api/wholesale/suppliers', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = registerSupplierSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const row = await registerWholesaleSupplier(parsed.data);
      return reply.status(201).send(row);
    } catch (err) {
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel wholesale supplier failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // Ranking de fornecedor (quanto comprei de cada / quem sumiu).
  fastify.get('/admin/api/wholesale/suppliers/ranking', { preHandler: requireAdminAuth }, async (_request, reply) => {
    return reply.status(200).send(dashboardPayload(await getWholesaleSupplierRanking()));
  });

  // Quebra fornecedor × medida: "quem vende a medida X mais barato" + especialidade.
  fastify.get('/admin/api/wholesale/suppliers/breakdown', { preHandler: requireAdminAuth }, async (_request, reply) => {
    return reply.status(200).send(dashboardPayload(await getWholesaleSupplierMeasureBreakdown()));
  });

  fastify.get('/admin/api/wholesale/suppliers/insights', { preHandler: requireAdminAuth }, async (_request, reply) => {
    return reply.status(200).send(dashboardPayload(await getWholesaleSupplierInsights()));
  });

  fastify.get('/admin/api/wholesale/suppliers/prices', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = priceReportQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_query' });
    }
    const rows = await getWholesalePriceReport({
      period: parsed.data.period,
      supplierId: parsed.data.supplier_id,
      search: parsed.data.search,
    });
    return reply.status(200).send(dashboardPayload(rows));
  });

  // Histórico de compras (cabeçalhos, mais recente primeiro).
  fastify.get('/admin/api/wholesale/purchases', { preHandler: requireAdminAuth }, async (_request, reply) => {
    return reply.status(200).send(dashboardPayload(await listWholesalePurchases()));
  });

  fastify.get('/admin/api/wholesale/purchases/report', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = purchaseReportQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_query' });
    }
    const report = await getWholesalePurchaseReport({
      period: parsed.data.period,
      status: parsed.data.status,
      payment: parsed.data.payment,
      search: parsed.data.search,
      page: parsed.data.page,
      pageSize: parsed.data.page_size,
    });
    return reply.status(200).send({ environment: env.FAREJADOR_ENV, ...report });
  });

  // Registra compra: recebida alimenta o galpão na transação; pendente não toca estoque.
  fastify.post('/admin/api/wholesale/purchases', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = registerPurchaseSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const result = await registerWholesalePurchase({ ...parsed.data, created_by: operatorLabel(request) });
      return reply.status(201).send(result);
    } catch (err) {
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel wholesale purchase failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // Confirma recebimento pendente; a entrada no galpao acontece uma unica vez.
  fastify.post('/admin/api/wholesale/purchases/confirm', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = confirmWholesalePurchaseSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const result = await confirmWholesalePurchase({ ...parsed.data, confirmed_by: operatorLabel(request) });
      return reply.status(200).send({ confirmed: true, ...result });
    } catch (err) {
      if (err instanceof Error && err.message === 'purchase_not_found') {
        return reply.status(404).send({ error: err.message });
      }
      if (err instanceof Error && ['purchase_already_confirmed', 'purchase_already_cancelled'].includes(err.message)) {
        return reply.status(409).send({ error: err.message });
      }
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel wholesale purchase confirm failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // Cancela com trilha. Recebida só reverte se saldo e custo ainda coincidirem
  // exatamente com o movimento original; pendente não toca estoque.
  fastify.post('/admin/api/wholesale/purchases/cancel', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = cancelWholesalePurchaseSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const result = await cancelWholesalePurchase({
        purchase_id: parsed.data.purchase_id,
        reason: parsed.data.reason ?? null,
        environment: env.FAREJADOR_ENV,
        idempotency_key: parsed.data.idempotency_key,
        cancelled_by: operatorLabel(request),
      });
      return reply.status(200).send({ cancelled: true, ...result });
    } catch (err) {
      if (err instanceof Error && err.message === 'purchase_not_found') {
        return reply.status(404).send({ error: 'purchase_not_found' });
      }
      if (err instanceof Error && err.message === 'purchase_already_cancelled') {
        return reply.status(409).send({ error: 'purchase_already_cancelled' });
      }
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel wholesale purchase cancel failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // ARQUIVA um fornecedor (soft delete): some do form/ranking; compras e dívida ficam.
  fastify.post('/admin/api/wholesale/suppliers/archive', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = archiveWholesaleSupplierSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const result = await archiveWholesaleSupplier(parsed.data.supplier_id, env.FAREJADOR_ENV);
      return reply.status(200).send({ archived: true, ...result });
    } catch (err) {
      if (err instanceof Error && err.message === 'supplier_not_found') {
        return reply.status(404).send({ error: 'supplier_not_found' });
      }
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel wholesale supplier archive failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // ── ATACADO — FINANCEIRO (0115): o fiado do galpão (a receber / a pagar) ──
  // Admin-only + flag WHOLESALE_FINANCE (off = enabled:false, a UI se esconde).

  // Resumo do fiado: totais, vencidos e as listas em aberto.
}
