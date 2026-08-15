import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { logger } from '../../shared/logger.js';
import type { CaixaAuth } from './queries.js';
import {
  getMatrizOperationCommissionRule, getMatrizOperationCompensation,
  getMatrizOperationTeam, saveMatrizOperationCommissionRule,
  saveMatrizOperationCompensation,
} from './operation-team.js';
import {
  getMatrizOperationPermissions,
  saveMatrizOperationPermissions,
} from './operation-team-permissions.js';

type Gate = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
type AuthenticatedRequest = FastifyRequest & { caixa?: CaixaAuth };

const params = z.object({ collaboratorId: z.string().uuid() });
const money = z.number().finite().min(0).max(10_000_000);
const benefits = z.array(z.object({
  name: z.string().trim().min(2).max(60), amount: money,
  active: z.boolean().default(true),
})).max(12);
const compensation = z.object({
  employment_type: z.enum(['clt', 'mei', 'autonomo', 'outro']),
  base_salary: money, payment_day: z.number().int().min(1).max(28),
  payment_method: z.enum(['pix', 'transferencia', 'dinheiro', 'outro']),
  starts_on: z.string().date(), benefits,
});
const commission = z.object({
  kind: z.enum(['percent', 'fixed']),
  basis: z.enum(['margin', 'revenue', 'sale', 'delivery', 'trip']),
  value: money, active: z.boolean(), starts_on: z.string().date(),
}).superRefine((row, ctx) => {
  if (row.kind === 'percent' && (!['margin', 'revenue'].includes(row.basis) || row.value > 100)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid_commission_rule' });
  }
  if (row.kind === 'fixed' && !['sale', 'delivery', 'trip'].includes(row.basis)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid_commission_rule' });
  }
});
const permissions = z.object({
  vendas: z.boolean(), entregas: z.boolean(), financeiro: z.boolean(),
});

function failure(reply: FastifyReply, error: unknown, label: string) {
  const code = error instanceof Error ? error.message : 'team_unavailable';
  if (code === 'collaborator_not_found') return reply.status(404).send({ error: code });
  if (code === 'owner_permissions_locked') return reply.status(409).send({ error: code });
  if (code === 'invalid_commission_basis') return reply.status(400).send({ error: code });
  logger.error({ err: error }, label);
  return reply.status(503).send({ error: 'team_unavailable' });
}

export function registerCaixaTeamRoutes(
  fastify: FastifyInstance,
  flagGate: Gate,
  requireAuth: Gate,
  requireFinance: Gate,
): void {
  const requireOwner: Gate = async (request, reply) => {
    if ((request as AuthenticatedRequest).caixa?.panelRole !== 'owner') {
      await reply.status(403).send({ error: 'owner_required' });
    }
  };
  const guards = [flagGate, requireAuth, requireFinance, requireOwner];

  fastify.get('/api/caixa/equipe', { preHandler: guards }, async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try { return reply.status(200).send(await getMatrizOperationTeam()); }
    catch (error) { return failure(reply, error, 'matrix operation team unavailable'); }
  });

  fastify.get('/api/caixa/equipe/:collaboratorId/remuneracao', { preHandler: guards }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = params.safeParse(request.params ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
    try {
      const payload = await getMatrizOperationCompensation(parsed.data.collaboratorId);
      return payload ? reply.status(200).send(payload) : reply.status(404).send({ error: 'collaborator_not_found' });
    } catch (error) { return failure(reply, error, 'matrix compensation unavailable'); }
  });

  fastify.put('/api/caixa/equipe/:collaboratorId/remuneracao', { preHandler: guards }, async (request, reply) => {
    const id = params.safeParse(request.params ?? {}); const body = compensation.safeParse(request.body ?? {});
    if (!id.success || !body.success) return reply.status(400).send({ error: 'invalid_request' });
    const auth = (request as AuthenticatedRequest).caixa!;
    try {
      return reply.status(200).send(await saveMatrizOperationCompensation({
        collaborator_id: id.data.collaboratorId, ...body.data, actor_label: auth.displayName,
      }));
    } catch (error) { return failure(reply, error, 'matrix compensation save failed'); }
  });

  fastify.get('/api/caixa/equipe/:collaboratorId/comissao', { preHandler: guards }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = params.safeParse(request.params ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
    try {
      const payload = await getMatrizOperationCommissionRule(parsed.data.collaboratorId);
      return payload ? reply.status(200).send(payload) : reply.status(404).send({ error: 'collaborator_not_found' });
    } catch (error) { return failure(reply, error, 'matrix commission rule unavailable'); }
  });

  fastify.put('/api/caixa/equipe/:collaboratorId/comissao', { preHandler: guards }, async (request, reply) => {
    const id = params.safeParse(request.params ?? {}); const body = commission.safeParse(request.body ?? {});
    if (!id.success || !body.success) return reply.status(400).send({ error: 'invalid_request' });
    const auth = (request as AuthenticatedRequest).caixa!;
    try {
      return reply.status(200).send(await saveMatrizOperationCommissionRule({
        collaborator_id: id.data.collaboratorId, ...body.data, actor_label: auth.displayName,
      }));
    } catch (error) { return failure(reply, error, 'matrix commission rule save failed'); }
  });

  fastify.get('/api/caixa/equipe/:collaboratorId/permissoes', { preHandler: guards }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = params.safeParse(request.params ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
    try {
      const payload = await getMatrizOperationPermissions(parsed.data.collaboratorId);
      return payload ? reply.status(200).send(payload) : reply.status(404).send({ error: 'collaborator_not_found' });
    } catch (error) { return failure(reply, error, 'matrix operation permissions unavailable'); }
  });

  fastify.put('/api/caixa/equipe/:collaboratorId/permissoes', { preHandler: guards }, async (request, reply) => {
    const id = params.safeParse(request.params ?? {}); const body = permissions.safeParse(request.body ?? {});
    if (!id.success || !body.success) return reply.status(400).send({ error: 'invalid_request' });
    const auth = (request as AuthenticatedRequest).caixa!;
    try {
      return reply.status(200).send(await saveMatrizOperationPermissions(
        id.data.collaboratorId, body.data, auth.displayName,
      ));
    } catch (error) { return failure(reply, error, 'matrix operation permissions save failed'); }
  });
}
