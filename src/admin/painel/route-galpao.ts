// Obra 300 (2026-07-05): fatia da PORTARIA da matriz — estoque do galpão (entrada/definir/remover).
// VERBATIM das linhas 543-599 do route.ts pré-obra (corpo de registerPainelRoute).
// Registrada por ./route.js (porta de entrada) na ordem original.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminAuth, requireAdminOwner } from '../auth.js';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/logger.js';
import {
  addWholesaleStockEntryComRotulo, applyGalpaoBaixaManual, applyMatrizPhysicalStockCount,
  correctWholesaleStockBrand,
  deleteWholesaleStockComRotulo,
  getMatrizStockReconciliation, listGalpaoMovements, listWholesaleStock, setWholesaleStockComRotulo,
  transferWholesaleStockCondition,
} from './queries.js';
import { dashboardPayload, mapWriteError, operatorLabel } from './route-helpers.js';
import {
  baixaWholesaleStockSchema, correctWholesaleStockBrandSchema,
  entryWholesaleStockSchema, physicalStockCountSchema,
  removeWholesaleStockSchema, setWholesaleStockSchema,
  transferWholesaleStockConditionSchema,
} from './route-schemas-stock.js';

export async function registerPainelGalpao(fastify: FastifyInstance): Promise<void> {
  fastify.get('/admin/api/wholesale/stock', { preHandler: requireAdminAuth }, async (_request, reply) => {
    return reply.status(200).send(dashboardPayload(await listWholesaleStock()));
  });

  fastify.get('/admin/api/wholesale/stock/reconciliation', { preHandler: requireAdminAuth }, async (_request, reply) => {
    return reply.status(200).send(await getMatrizStockReconciliation());
  });

  fastify.post('/admin/api/wholesale/stock/physical-count', {
    preHandler: requireAdminOwner,
  }, async (request, reply) => {
    const parsed = physicalStockCountSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: parsed.error.issues[0]?.message ?? 'invalid_body',
      });
    }
    try {
      return reply.status(200).send(await applyMatrizPhysicalStockCount({
        ...parsed.data, actor_label: operatorLabel(request),
      }));
    } catch (error) {
      const code = error instanceof Error ? error.message : 'internal_server_error';
      if (['reason_required', 'physical_count_rows_required', 'physical_count_invalid',
        'physical_count_duplicate_measure'].includes(code)) {
        return reply.status(400).send({ error: code });
      }
      if (code === 'physical_count_measure_not_found') {
        return reply.status(409).send({ error: code });
      }
      if (code.startsWith('physical_count_below_reserved:')) {
        return reply.status(409).send({ error: code });
      }
      const mapped = mapWriteError(error);
      logger.error({ error, status: mapped.status }, 'physical stock count failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // ENTRADA de compra: soma a quantidade e recalcula o custo MÉDIO ponderado da medida.
  fastify.post('/admin/api/wholesale/stock/entry', { preHandler: requireAdminOwner }, async (request, reply) => {
    const parsed = entryWholesaleStockSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const row = await addWholesaleStockEntryComRotulo({
        ...parsed.data, actor_label: operatorLabel(request),
      });
      return reply.status(200).send(row);
    } catch (err) {
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel wholesale stock entry failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // Define a quantidade de uma medida (upsert por medida).
  fastify.post('/admin/api/wholesale/stock', { preHandler: requireAdminOwner }, async (request, reply) => {
    const parsed = setWholesaleStockSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const row = await setWholesaleStockComRotulo({
        ...parsed.data, actor_label: operatorLabel(request),
      });
      return reply.status(200).send(row);
    } catch (err) {
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel wholesale stock set failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // Remove uma medida do estoque do galpão.
  fastify.post('/admin/api/wholesale/stock/remove', { preHandler: requireAdminOwner }, async (request, reply) => {
    const parsed = removeWholesaleStockSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      await deleteWholesaleStockComRotulo({
        ...parsed.data,
        actor_label: operatorLabel(request),
      });
      return reply.status(200).send({ ok: true });
    } catch (err) {
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel wholesale stock remove failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  fastify.post('/admin/api/wholesale/stock/condition-transfer', {
    preHandler: requireAdminOwner,
  }, async (request, reply) => {
    const parsed = transferWholesaleStockConditionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: parsed.error.issues[0]?.message ?? 'invalid_body',
      });
    }
    try {
      return reply.status(200).send(await transferWholesaleStockCondition({
        ...parsed.data,
        actor_label: operatorLabel(request),
      }));
    } catch (error) {
      const code = error instanceof Error ? error.message : 'internal_server_error';
      if (code.startsWith('condition_transfer_insufficient:')) {
        return reply.status(409).send({ error: code });
      }
      if ([
        'condition_transfer_same', 'condition_transfer_source_not_found',
        'quantity_invalid', 'reason_required',
      ].includes(code)) {
        return reply.status(code === 'condition_transfer_source_not_found' ? 404 : 400)
          .send({ error: code });
      }
      const mapped = mapWriteError(error);
      logger.error({ error, status: mapped.status }, 'stock condition transfer failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  fastify.post('/admin/api/wholesale/stock/brand-correction', {
    preHandler: requireAdminOwner,
  }, async (request, reply) => {
    const parsed = correctWholesaleStockBrandSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: parsed.error.issues[0]?.message ?? 'invalid_body',
      });
    }
    try {
      return reply.status(200).send(await correctWholesaleStockBrand({
        ...parsed.data,
        actor_label: operatorLabel(request),
      }));
    } catch (error) {
      const code = error instanceof Error ? error.message : 'internal_server_error';
      if (code === 'brand_correction_source_not_found') {
        return reply.status(404).send({ error: code });
      }
      if ([
        'brand_correction_source_ambiguous', 'brand_correction_target_exists',
        'brand_correction_catalog_ambiguous', 'brand_correction_catalog_conflict',
      ].includes(code)) {
        return reply.status(409).send({ error: code });
      }
      if ([
        'brand_correction_measure_invalid', 'brand_correction_target_required',
        'brand_correction_same', 'reason_required',
      ].includes(code)) {
        return reply.status(400).send({ error: code });
      }
      const mapped = mapWriteError(error);
      logger.error({ error, status: mapped.status }, 'stock brand correction failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // BAIXA MANUAL com motivo (0128): quebra/perda/uso — recusa acima do saldo (não é venda).
  fastify.post('/admin/api/wholesale/stock/baixa', { preHandler: requireAdminOwner }, async (request, reply) => {
    const parsed = baixaWholesaleStockSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const row = await applyGalpaoBaixaManual({
        ...parsed.data, actor_label: operatorLabel(request),
      });
      return reply.status(200).send(row);
    } catch (err) {
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel wholesale stock baixa failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // O FILME do galpão (0128): últimos movimentos, todos ou de uma medida (?measure=&limit=).
  fastify.get('/admin/api/wholesale/stock/movimentos', { preHandler: requireAdminAuth }, async (request, reply) => {
    const q = request.query as {
      measure?: string; brand?: string;
      tire_condition?: 'meia_vida' | 'novo' | 'remold'; limit?: string;
    };
    const limit = Math.min(Math.max(1, Number(q.limit) || 50), 200);
    const rows = await listGalpaoMovements({
      measure: q.measure?.slice(0, 60) || null,
      brand: q.brand?.slice(0, 60) || null,
      tire_condition: q.tire_condition ?? null,
      limit,
    });
    return reply.status(200).send(dashboardPayload(rows));
  });

  // ── ATACADO — FORNECEDORES (0114): cadastro + compra (entrada com origem) ──
  // Admin-only (dado SÓ da matriz; parceiro sem grant no banco). A compra alimenta
  // o custo médio do galpão na mesma transação (registerWholesalePurchase).

  // Lista de fornecedores (dropdown do formulário de compra + gestão).
}
