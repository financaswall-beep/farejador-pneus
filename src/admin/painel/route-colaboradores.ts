// Obra 300 (2026-07-05): fatia da PORTARIA da matriz — colaboradores da matriz (0124).
// VERBATIM das linhas 1284-1398 do route.ts pré-obra (corpo de registerPainelRoute).
// Registrada por ./route.js (porta de entrada) na ordem original.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminOwner } from '../auth.js';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/logger.js';
import { MatrizCollaboratorUsernameTakenError, MatrizLastOwnerError, createMatrizCollaborator, listMatrizCollaborators, reactivateMatrizCollaborator, resetMatrizCollaboratorPassword, revokeMatrizCollaborator, updateMatrizCollaboratorJob, updateMatrizCollaboratorPanelRole } from './queries.js';
import { mapWriteError, operatorLabel } from './route-helpers.js';

export async function registerPainelColaboradores(fastify: FastifyInstance): Promise<void> {
  // ── Colaboradores da MATRIZ (0124 — fatia 1: cadastro; dono-only) ──
  // Mesma régua de formato do login da porta única (login-global.route.ts):
  // username 3-60 [a-zA-Z0-9._-], senha 6-200. As telas por função vêm depois.
  const colaboradorUsernameField = z.string().trim().min(3).max(60).regex(/^[a-zA-Z0-9._-]+$/, 'usuario_invalido');
  const criarColaboradorSchema = z.object({
    display_name: z.string().trim().min(2).max(120),
    username: colaboradorUsernameField,
    password: z.string().min(12).max(200),
    job: z.enum(['vendedor', 'entregador']),
    panel_role: z.enum(['owner', 'admin']).nullable().default(null),
  });
  const funcaoColaboradorSchema = z.object({
    id: z.string().uuid(),
    job: z.enum(['vendedor', 'entregador']),
  });
  const idColaboradorSchema = z.object({ id: z.string().uuid() });
  const acessoColaboradorSchema = z.object({
    id: z.string().uuid(),
    panel_role: z.enum(['owner', 'admin']).nullable(),
  });
  const senhaColaboradorSchema = z.object({
    id: z.string().uuid(),
    password: z.string().min(12).max(200),
  });

  fastify.get('/admin/api/colaboradores', { preHandler: requireAdminOwner }, async (_request, reply) => {
    try {
      return reply.status(200).send({ collaborators: await listMatrizCollaborators() });
    } catch (err) {
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel colaboradores list failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  fastify.post('/admin/api/colaboradores', { preHandler: requireAdminOwner }, async (request, reply) => {
    const parsed = criarColaboradorSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const result = await createMatrizCollaborator({ ...parsed.data, actor_label: operatorLabel(request) });
      return reply.status(201).send({ created: true, ...result });
    } catch (err) {
      if (err instanceof MatrizCollaboratorUsernameTakenError) {
        return reply.status(409).send({ error: 'username_taken' });
      }
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel colaboradores create failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  fastify.post('/admin/api/colaboradores/funcao', { preHandler: requireAdminOwner }, async (request, reply) => {
    const parsed = funcaoColaboradorSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const result = await updateMatrizCollaboratorJob(parsed.data);
      if (!result.updated) return reply.status(404).send({ error: 'collaborator_not_found' });
      return reply.status(200).send({ updated: true });
    } catch (err) {
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel colaboradores funcao failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  fastify.post('/admin/api/colaboradores/acesso', { preHandler: requireAdminOwner }, async (request, reply) => {
    const parsed = acessoColaboradorSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body' });
    try {
      const result = await updateMatrizCollaboratorPanelRole(parsed.data);
      if (!result.updated) return reply.status(404).send({ error: 'collaborator_not_found' });
      return reply.status(200).send({ updated: true });
    } catch (error) {
      if (error instanceof MatrizLastOwnerError) return reply.status(409).send({ error: 'last_owner_required' });
      const mapped = mapWriteError(error);
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  fastify.post('/admin/api/colaboradores/revogar', { preHandler: requireAdminOwner }, async (request, reply) => {
    const parsed = idColaboradorSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const result = await revokeMatrizCollaborator(parsed.data);
      if (!result.revoked) return reply.status(404).send({ error: 'collaborator_not_found' });
      return reply.status(200).send({ revoked: true });
    } catch (err) {
      if (err instanceof MatrizLastOwnerError) return reply.status(409).send({ error: 'last_owner_required' });
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel colaboradores revogar failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  fastify.post('/admin/api/colaboradores/reativar', { preHandler: requireAdminOwner }, async (request, reply) => {
    const parsed = idColaboradorSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const result = await reactivateMatrizCollaborator(parsed.data);
      if (!result.reactivated) return reply.status(404).send({ error: 'collaborator_not_found' });
      return reply.status(200).send({ reactivated: true });
    } catch (err) {
      if (err instanceof MatrizCollaboratorUsernameTakenError) {
        return reply.status(409).send({ error: 'username_taken' });
      }
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel colaboradores reativar failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

  fastify.post('/admin/api/colaboradores/senha', { preHandler: requireAdminOwner }, async (request, reply) => {
    const parsed = senhaColaboradorSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    }
    try {
      const result = await resetMatrizCollaboratorPassword(parsed.data);
      if (!result.reset) return reply.status(404).send({ error: 'collaborator_not_found' });
      return reply.status(200).send({ reset: true });
    } catch (err) {
      const mapped = mapWriteError(err);
      logger.error({ err, status: mapped.status }, 'painel colaboradores senha failed');
      return reply.status(mapped.status).send({ error: mapped.error });
    }
  });

}
