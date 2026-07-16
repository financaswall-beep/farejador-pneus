// Obra 300 (2026-07-05): fatia da PORTARIA da matriz — estoque do galpão (entrada/definir/remover).
// VERBATIM das linhas 543-599 do route.ts pré-obra (corpo de registerPainelRoute).
// Registrada por ./route.js (porta de entrada) na ordem original.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminAuth } from '../auth.js';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/logger.js';
import {
  addWholesaleStockEntryComRotulo, applyGalpaoBaixaManual, deleteWholesaleStockComRotulo,
  getMatrizStockReconciliation, listGalpaoMovements, listWholesaleStock, setWholesaleStockComRotulo,
} from './queries.js';
import { dashboardPayload, mapWriteError } from './route-helpers.js';
import { baixaWholesaleStockSchema, entryWholesaleStockSchema, removeWholesaleStockSchema, setWholesaleStockSchema } from './route-schemas.js';

export async function registerPainelGalpao(fastify: FastifyInstance): Promise<void> {
  fastify.get('/admin/api/wholesale/stock', { preHandler: requireAdminAuth }, async (_request, reply) => {
    return reply.status(200).send(dashboardPayload(await listWholesaleStock()));
  });

  fastify.get('/admin/api/wholesale/stock/reconciliation', { preHandler: requireAdminAuth }, async (_request, reply) => {
    return reply.status(200).send(await getMatrizStockReconciliation());
  });

  // ENTRADA de compra: soma a quantidade e recalcula o custo MÉDIO ponderado da medida.
  fastify.post('/admin/api/wholesale/stock/entry', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = entryWholesaleStockSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const row = await addWholesaleStockEntryComRotulo(parsed.data);
      return reply.status(200).send(row);
    } catch (err) {
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel wholesale stock entry failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // Define a quantidade de uma medida (upsert por medida).
  fastify.post('/admin/api/wholesale/stock', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = setWholesaleStockSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const row = await setWholesaleStockComRotulo(parsed.data);
      return reply.status(200).send(row);
    } catch (err) {
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel wholesale stock set failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // Remove uma medida do estoque do galpão.
  fastify.post('/admin/api/wholesale/stock/remove', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = removeWholesaleStockSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      await deleteWholesaleStockComRotulo(parsed.data.measure);
      return reply.status(200).send({ ok: true });
    } catch (err) {
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel wholesale stock remove failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // BAIXA MANUAL com motivo (0128): quebra/perda/uso — recusa acima do saldo (não é venda).
  fastify.post('/admin/api/wholesale/stock/baixa', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = baixaWholesaleStockSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const row = await applyGalpaoBaixaManual(parsed.data);
      return reply.status(200).send(row);
    } catch (err) {
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel wholesale stock baixa failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // O FILME do galpão (0128): últimos movimentos, todos ou de uma medida (?measure=&limit=).
  fastify.get('/admin/api/wholesale/stock/movimentos', { preHandler: requireAdminAuth }, async (request, reply) => {
    const q = request.query as { measure?: string; limit?: string };
    const limit = Math.min(Math.max(1, Number(q.limit) || 50), 200);
    const rows = await listGalpaoMovements({ measure: q.measure?.slice(0, 60) || null, limit });
    return reply.status(200).send(dashboardPayload(rows));
  });

  // ── ATACADO — FORNECEDORES (0114): cadastro + compra (entrada com origem) ──
  // Admin-only (dado SÓ da matriz; parceiro sem grant no banco). A compra alimenta
  // o custo médio do galpão na mesma transação (registerWholesalePurchase).

  // Lista de fornecedores (dropdown do formulário de compra + gestão).
}
