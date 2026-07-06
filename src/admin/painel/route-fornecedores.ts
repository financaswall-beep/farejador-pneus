// Obra 300 (2026-07-05): fatia da PORTARIA da matriz — fornecedores + compras.
// VERBATIM das linhas 600-654 do route.ts pré-obra (corpo de registerPainelRoute).
// Registrada por ./route.js (porta de entrada) na ordem original.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminAuth } from '../auth.js';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/logger.js';
import { getWholesaleSupplierMeasureBreakdown, getWholesaleSupplierRanking, listWholesalePurchases, listWholesaleSuppliers, registerWholesalePurchase, registerWholesaleSupplier } from './queries.js';
import { dashboardPayload, mapWriteError, operatorLabel } from './route-helpers.js';
import { registerPurchaseSchema, registerSupplierSchema } from './route-schemas.js';

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

  // Histórico de compras (cabeçalhos, mais recente primeiro).
  fastify.get('/admin/api/wholesale/purchases', { preHandler: requireAdminAuth }, async (_request, reply) => {
    return reply.status(200).send(dashboardPayload(await listWholesalePurchases()));
  });

  // Registra uma COMPRA (entrada) → alimenta o custo médio do galpão (mesma transação).
  fastify.post('/admin/api/wholesale/purchases', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = registerPurchaseSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const result = await registerWholesalePurchase({ ...parsed.data, created_by: operatorLabel(request.headers) });
      return reply.status(201).send(result);
    } catch (err) {
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel wholesale purchase failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // ── ATACADO — FINANCEIRO (0115): o fiado do galpão (a receber / a pagar) ──
  // Admin-only + flag WHOLESALE_FINANCE (off = enabled:false, a UI se esconde).

  // Resumo do fiado: totais, vencidos e as listas em aberto.
}
