// Obra 300 (2026-07-05): fatia da PORTARIA da matriz — cadastro de parceiro + raio de entrega.
// VERBATIM das linhas 1116-1161 do route.ts pré-obra (corpo de registerPainelRoute).
// Registrada por ./route.js (porta de entrada) na ordem original.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminAuth } from '../auth.js';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/logger.js';
import { createPartnerUnit, setPartnerUnitDeliveryRadius } from './queries.js';
import { mapWriteError, operatorLabel } from './route-helpers.js';
import { createPartnerSchema, setDeliveryRadiusBodySchema, setDeliveryRadiusParamsSchema } from './route-schemas.js';

export async function registerPainelParceiros(fastify: FastifyInstance): Promise<void> {
  fastify.post('/admin/api/partners', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = createPartnerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const result = await createPartnerUnit({ ...parsed.data, actor_label: operatorLabel(request) });
      if (result.already_exists) {
        return reply.status(409).send({ error: 'slug_already_exists', slug: result.slug });
      }
      return reply.status(201).send(result);
    } catch (err) {
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel create partner failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // ADMIN: matriz define o raio de entrega de um parceiro (proximidade-primeiro Fase 2).
  // Só preenche o raio de quem JÁ faz entrega (não força entrega em quem é só retirada).
  fastify.put('/admin/api/partners/:partnerUnitId/delivery-radius', { preHandler: requireAdminAuth }, async (request, reply) => {
    const params = setDeliveryRadiusParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'invalid_partner_unit_id' });
    const body = setDeliveryRadiusBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.status(400).send({ error: body.error.issues[0]?.message ?? 'invalid_body' });
    }
    const environment = body.data.environment ?? env.FAREJADOR_ENV;
    try {
      const result = await setPartnerUnitDeliveryRadius(environment, params.data.partnerUnitId, body.data.delivery_radius_km);
      if (!result.updated) {
        if (result.reason === 'not_found') return reply.status(404).send({ error: 'partner_not_found' });
        if (result.reason === 'pickup_only') return reply.status(409).send({ error: 'partner_pickup_only' });
        return reply.status(404).send({ error: 'partner_not_found' });
      }
      return reply.status(200).send({ updated: true, delivery_radius_km: body.data.delivery_radius_km });
    } catch (err) {
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel set delivery radius failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // ── Etapa 3: candidaturas de parceiro (funil de recrutamento) ──

  // PÚBLICO (sem auth): formulário "quero ser parceiro" insere uma candidatura pendente.
}
