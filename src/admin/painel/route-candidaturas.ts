// Obra 300 (2026-07-05): fatia da PORTARIA da matriz — seja-parceiro (público) + fila de candidaturas.
// VERBATIM das linhas 1162-1225 do route.ts pré-obra (corpo de registerPainelRoute).
// Registrada por ./route.js (porta de entrada) na ordem original.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminAuth } from '../auth.js';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/logger.js';
import { approvePartnerApplication, createPartnerApplication, listPartnerApplications, rejectPartnerApplication } from './queries.js';
import { dashboardPayload, mapWriteError, operatorLabel, sendStatic } from './route-helpers.js';
import { applicationsQuerySchema, approveApplicationSchema, partnerApplicationSchema } from './route-schemas.js';

export async function registerPainelCandidaturas(fastify: FastifyInstance): Promise<void> {
  fastify.post('/api/seja-parceiro', async (request, reply) => {
    const parsed = partnerApplicationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    // honeypot: bots preenchem 'website'; humano deixa vazio → finge sucesso e não grava.
    if (parsed.data.website && parsed.data.website.trim().length > 0) {
      return reply.status(201).send({ ok: true });
    }
    try {
      const result = await createPartnerApplication(parsed.data);
      return reply.status(201).send({ ok: true, id: result.id });
    } catch (err) {
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'partner application submit failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // PÚBLICO: a página do formulário.
  fastify.get('/seja-parceiro', async (_request, reply) =>
    sendStatic(reply, 'seja-parceiro.html', 'text/html; charset=utf-8'));

  // ADMIN: fila de candidaturas.
  fastify.get('/admin/api/partner-applications', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = applicationsQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_query' });
    return reply.status(200).send(dashboardPayload(await listPartnerApplications(parsed.data.status)));
  });

  // ADMIN: aprovar candidatura → cria o parceiro (login + cobertura) e marca approved.
  fastify.post('/admin/api/partner-applications/:id/approve', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = approveApplicationSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    const { id } = request.params as { id: string };
    try {
      const result = await approvePartnerApplication({
        ...parsed.data,
        application_id: id,
        actor_label: operatorLabel(request.headers),
      });
      if (result.already_exists) return reply.status(409).send({ error: 'slug_already_exists', slug: result.slug });
      return reply.status(200).send(result);
    } catch (err) {
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'partner application approve failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  // ADMIN: recusar candidatura.
  fastify.post('/admin/api/partner-applications/:id/reject', { preHandler: requireAdminAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { notes?: string };
    try {
      const result = await rejectPartnerApplication(id, operatorLabel(request.headers), body.notes ?? null);
      return reply.status(200).send(result);
    } catch (err) {
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'partner application reject failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

}
