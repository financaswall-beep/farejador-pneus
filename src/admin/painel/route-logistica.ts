// Obra 300 (2026-07-05): fatia da PORTARIA da matriz — logística (0121): parser de imagem,
// schemas e LEITURA/status/falhou/recolocar/remarcar. Schemas eram function-local no
// pré-obra (linhas 812-846): içados pro nível de módulo com 'export' (de-indent mecânico,
// prova reversa no gerador) porque a metade rotas/comprovantes usa os mesmos schemas.
// Corpo VERBATIM: linhas 796-811 + 847-947 do route.ts pré-obra.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminAuth } from '../auth.js';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/logger.js';
import { failMatrizDelivery, getMatrizLogistica, listMatrizExpenseCategories,
  requeueMatrizDelivery, rescheduleMatrizDelivery, setMatrizDeliveryStatus } from './queries.js';
import { dashboardPayload, mapWriteError, operatorLabel } from './route-helpers.js';

export const logisticaStatusSchema = z.object({
  order_id: z.string().uuid(),
  status: z.enum(['dispatched', 'delivered']),
  courier: z.string().max(120).optional().nullable(),
  payment_method: z.string().max(40).optional().nullable(),
});
export const logisticaFalhouSchema = z.object({
  order_id: z.string().uuid(),
  reason: z.string().max(500).optional().nullable(),
});
export const logisticaRecolocarSchema = z.object({
  order_id: z.string().uuid(),
});
export const abrirRotaSchema = z.object({
  courier_name: z.string().min(1, 'courier_required').max(120),
  km_start: z.coerce.number().min(0).max(9999999).optional().nullable(),
  order_ids: z.array(z.string().uuid()).max(100).optional(),
});
export const fecharRotaSchema = z.object({
  trip_id: z.string().uuid(),
  km_end: z.coerce.number().min(0).max(9999999).optional().nullable(),
  fuel_spent: z.coerce.number().min(0).max(99999).optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
});
export const pendurarRotaSchema = z.object({
  order_id: z.string().uuid(),
  trip_id: z.string().uuid(),
});
export const remarcarEntregaSchema = z.object({
  order_id: z.string().uuid(),
  scheduled_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'data_invalida'),
});
export const comprovanteParamsSchema = z.object({ tripId: z.string().uuid() });
export const comprovanteIdParamsSchema = z.object({ receiptId: z.string().uuid() });
export const lerComprovanteSchema = z.object({ receipt_id: z.string().uuid() });
const receiptDecisionBaseSchema = z.object({
  receipt_id: z.string().uuid(),
  ai_attempt_id: z.string().uuid().optional().nullable(),
  idempotency_key: z.string().trim().min(8).max(200),
});
export const aprovarComprovanteSchema = receiptDecisionBaseSchema.extend({
  amount: z.coerce.number().positive(),
  suggested_amount: z.coerce.number().positive().optional().nullable(),
  category: z.string().trim().min(1).max(80),
  merchant: z.string().trim().max(200).optional().nullable(),
  document_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  competence_month: z.string().regex(/^\d{4}-\d{2}-01$/),
  payment_status: z.enum(['paid', 'pending']),
  payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  note: z.string().trim().max(500).optional().nullable(),
  retroactive_confirmed: z.boolean().optional(),
  competence_confirmed: z.boolean().optional(),
  possible_duplicate_confirmed: z.boolean().optional(),
  legacy_expense_confirmed: z.boolean().optional(),
});
export const rejeitarComprovanteSchema = receiptDecisionBaseSchema.extend({
  reason: z.string().trim().min(2).max(500),
});

export async function registerPainelLogistica(fastify: FastifyInstance): Promise<void> {
  // ── MATRIZ — LOGÍSTICA (0121, flag MATRIZ_LOGISTICS) ─────────────────────────
  // Entregas da 'main' nos moldes do parceiro + diário de rota do entregador
  // (km inicial/final, gasolina, comprovantes). "Não entregue" CANCELA no caminho
  // atômico (galpão volta pela trilha — fdd9148). IA do comprovante atrás de
  // MATRIZ_RECEIPT_AI apenas sugere; sem certeza → alerta; erro de rede → tentativa
  // falha e pode ser refeita. Somente aprovação administrativa cria a despesa.

  // Parser de imagem: corpo cru como Buffer (mesmo funil do upload de foto do parceiro).
  for (const mime of ['image/jpeg', 'image/png', 'image/webp'] as const) {
    if (!fastify.hasContentTypeParser(mime)) {
      fastify.addContentTypeParser(mime, { parseAs: 'buffer' }, (_req, body, done) => {
        done(null, body);
      });
    }
  }


  // A tela num GET: entregas abertas/finalizadas + rotas abertas/recentes.
  fastify.get('/admin/api/logistica', { preHandler: requireAdminAuth }, async (_request, reply) => {
    if (!env.MATRIZ_LOGISTICS) {
      return reply.status(200).send({ ...dashboardPayload([]), enabled: false });
    }
    const [logistica, categories] = await Promise.all([
      getMatrizLogistica(),
      env.MATRIZ_RECEIPT_APPROVAL ? listMatrizExpenseCategories() : Promise.resolve([]),
    ]);
    return reply.status(200).send({
      ...dashboardPayload([]),
      enabled: true,
      receipt_ai: env.MATRIZ_RECEIPT_AI,
      receipt_approval: env.MATRIZ_RECEIPT_APPROVAL,
      receipt_approval_finance: env.MATRIZ_EXPENSES,
      receipt_approval_max_amount: env.MATRIZ_RECEIPT_APPROVAL_MAX_AMOUNT,
      expense_categories: categories.filter((category) => !category.archived),
      ...logistica,
    });
  });

  // Saiu pra entrega / Entregue (entregue fecha o pedido; forma de pagamento opcional).
  fastify.post('/admin/api/logistica/entregas/status', { preHandler: requireAdminAuth }, async (request, reply) => {
    if (!env.MATRIZ_LOGISTICS) return reply.status(404).send({ error: 'logistics_disabled' });
    const parsed = logisticaStatusSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const result = await setMatrizDeliveryStatus(parsed.data);
      return reply.status(200).send({ updated: true, ...result });
    } catch (err) {
      if (err instanceof Error && err.message === 'delivery_not_found') {
        return reply.status(404).send({ error: 'delivery_not_found' });
      }
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel logistica status failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // NÃO ENTREGUE: marca failed e CANCELA (galpão volta) — atômico.
  fastify.post('/admin/api/logistica/entregas/falhou', { preHandler: requireAdminAuth }, async (request, reply) => {
    if (!env.MATRIZ_LOGISTICS) return reply.status(404).send({ error: 'logistics_disabled' });
    const parsed = logisticaFalhouSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const result = await failMatrizDelivery({
        ...parsed.data,
        actor_label: operatorLabel(request),
      });
      return reply.status(200).send({ failed: true, ...result });
    } catch (err) {
      if (err instanceof Error && err.message === 'delivery_not_found') {
        return reply.status(404).send({ error: 'delivery_not_found' });
      }
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel logistica falhou failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // RECOLOCA na fila uma entrega que o entregador REPORTOU não-entregue (0125): o
  // dono discorda do reporte (cliente remarcou, engano) → volta pra 'pending', solta
  // da rota. Só mexe em failed ainda NÃO cancelado (o confirmado é terminal).
  fastify.post('/admin/api/logistica/entregas/recolocar', { preHandler: requireAdminAuth }, async (request, reply) => {
    if (!env.MATRIZ_LOGISTICS) return reply.status(404).send({ error: 'logistics_disabled' });
    const parsed = logisticaRecolocarSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const result = await requeueMatrizDelivery(parsed.data);
      return reply.status(200).send({ requeued: true, ...result });
    } catch (err) {
      if (err instanceof Error && err.message === 'delivery_not_found') {
        return reply.status(404).send({ error: 'delivery_not_found' });
      }
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel logistica recolocar failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // REMARCA a data prevista de entrega (agendamento — 07-03e). Toda entrega nasce
  // pra D+1; aqui o dono empurra pra outro dia (ex.: não entregou no dia).
  fastify.post('/admin/api/logistica/entregas/remarcar', { preHandler: requireAdminAuth }, async (request, reply) => {
    if (!env.MATRIZ_LOGISTICS) return reply.status(404).send({ error: 'logistics_disabled' });
    const parsed = remarcarEntregaSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const result = await rescheduleMatrizDelivery(parsed.data);
      return reply.status(200).send({ rescheduled: true, ...result });
    } catch (err) {
      if (err instanceof Error && err.message === 'delivery_not_found') {
        return reply.status(404).send({ error: 'delivery_not_found' });
      }
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel logistica remarcar failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // ABRE a rota do dia (as entregas escolhidas saem juntas — dispatched).
}
