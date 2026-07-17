// Obra 300 (2026-07-05): fatia da PORTARIA da matriz — seja-parceiro (público) + fila de candidaturas.
// VERBATIM das linhas 1162-1225 do route.ts pré-obra (corpo de registerPainelRoute).
// Registrada por ./route.js (porta de entrada) na ordem original.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminAuth } from '../auth.js';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/logger.js';
import { approvePartnerApplication, createPartnerApplication, listPartnerApplications, reissuePartnerCredential, rejectPartnerApplication } from './queries.js';
import { dashboardPayload, mapWriteError, operatorLabel, sendStatic } from './route-helpers.js';
import { applicationsQuerySchema, approveApplicationSchema, partnerApplicationSchema } from './route-schemas.js';
import { rateLimitHit } from '../../shared/rate-limit.js';

const APPLICATION_MAX_PER_IP = 5;
const APPLICATION_WINDOW_MS = 60 * 60 * 1000;

export async function registerPainelCandidaturas(fastify: FastifyInstance): Promise<void> {
  const reissueCredentialSchema = z.object({
    idempotency_key: z.string().trim().min(8).max(200),
    reason: z.string().trim().min(5).max(500),
  });

  fastify.post('/api/seja-parceiro', async (request, reply) => {
    const parsed = partnerApplicationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    // honeypot: bots preenchem 'website'; humano deixa vazio → finge sucesso e não grava.
    if (parsed.data.website && parsed.data.website.trim().length > 0) {
      return reply.status(201).send({ ok: true });
    }
    if (rateLimitHit(`partner-application:${request.ip}`, APPLICATION_MAX_PER_IP, APPLICATION_WINDOW_MS)) {
      return reply.header('Retry-After', '3600').status(429).send({ error: 'too_many_attempts' });
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
        actor_label: operatorLabel(request),
      });
      if (result.already_exists) return reply.status(409).send({ error: 'slug_already_exists', slug: result.slug });
      return reply.status(200).send(result);
    } catch (err) {
      const message = (err as Error).message;
      if (message === 'application_not_found') return reply.status(404).send({ error: message });
      if (['application_not_pending','slug_already_exists','application_transition_conflict',
        'approved_application_unit_missing'].includes(message)) {
        return reply.status(409).send({ error: message });
      }
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
      const result = await rejectPartnerApplication(id, operatorLabel(request), body.notes ?? null);
      return reply.status(200).send(result);
    } catch (err) {
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'partner application reject failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  fastify.post('/admin/api/partner-units/:id/reissue-token', { preHandler: requireAdminAuth }, async (request, reply) => {
    const parsed = reissueCredentialSchema.safeParse(request.body);
    const { id } = request.params as { id: string };
    if (!parsed.success || !z.string().uuid().safeParse(id).success) {
      return reply.status(400).send({ error: 'invalid_body' });
    }
    try {
      return reply.status(200).send(await reissuePartnerCredential({ ...parsed.data,
        partner_unit_id: id,actor_label: operatorLabel(request) }));
    } catch (error) {
      if ((error as Error).message === 'partner_unit_not_found') {
        return reply.status(404).send({ error: 'partner_unit_not_found' });
      }
      const mapped = mapWriteError(error);
      logger.error({ err: error,status: mapped.status }, 'partner credential reissue failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

}
