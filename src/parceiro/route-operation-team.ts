import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { logger } from '../shared/logger.js';
import { getPartnerContext, requireOwner, requirePartnerAuth, type PartnerAuthedRequest } from './auth.js';
import {
  getPartnerOperationCommissionRule, getPartnerOperationCompensation,
  getPartnerOperationTeam, savePartnerOperationCommissionRule,
  savePartnerOperationCompensation,
} from './operation-team.js';

const owner = [requirePartnerAuth, requireOwner];
const params = z.object({ collaboratorId: z.string().uuid() });
const money = z.number().finite().min(0).max(10_000_000);
const today = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const startsOn = z.string().date().refine((value) => value <= today(), 'future_start_not_allowed');
const benefits = z.array(z.object({
  name: z.string().trim().min(2).max(60), amount: money, active: z.boolean().default(true),
})).max(12);
const compensation = z.object({
  employment_type: z.enum(['clt', 'mei', 'autonomo', 'outro']), base_salary: money,
  payment_day: z.number().int().min(1).max(28),
  payment_method: z.enum(['pix', 'transferencia', 'dinheiro', 'outro']),
  starts_on: startsOn, benefits,
});
const commission = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('percent'), basis: z.literal('revenue'), value: money.max(100), active: z.boolean(), starts_on: startsOn }),
  z.object({ kind: z.literal('fixed'), basis: z.literal('sale'), value: money, active: z.boolean(), starts_on: startsOn }),
]);

function bad(reply: FastifyReply, error: unknown, label: string) {
  const code = error instanceof Error ? error.message : 'team_unavailable';
  if (code === 'collaborator_not_found') return reply.status(404).send({ error: code });
  if (code === 'invalid_commission_basis') return reply.status(400).send({ error: code });
  logger.error({ err: error }, label);
  return reply.status(503).send({ error: 'team_unavailable' });
}

export function registerPartnerOperationTeamRoutes(fastify: FastifyInstance): void {
  fastify.get('/parceiro/:slug/api/equipe', { preHandler: owner }, async (request: PartnerAuthedRequest, reply) => {
    reply.header('Cache-Control', 'no-store');
    try { return reply.status(200).send(await getPartnerOperationTeam(getPartnerContext(request))); }
    catch (error) { return bad(reply, error, 'partner operation team unavailable'); }
  });

  fastify.get('/parceiro/:slug/api/equipe/:collaboratorId/remuneracao', { preHandler: owner }, async (request: PartnerAuthedRequest, reply) => {
    reply.header('Cache-Control', 'no-store'); const id = params.safeParse(request.params ?? {});
    if (!id.success) return reply.status(400).send({ error: 'invalid_request' });
    try {
      const payload = await getPartnerOperationCompensation(getPartnerContext(request), id.data.collaboratorId);
      return payload ? reply.status(200).send(payload) : reply.status(404).send({ error: 'collaborator_not_found' });
    } catch (error) { return bad(reply, error, 'partner compensation unavailable'); }
  });

  fastify.put('/parceiro/:slug/api/equipe/:collaboratorId/remuneracao', { preHandler: owner }, async (request: PartnerAuthedRequest, reply) => {
    const id = params.safeParse(request.params ?? {}); const body = compensation.safeParse(request.body ?? {});
    if (!id.success || !body.success) return reply.status(400).send({ error: body.success ? 'invalid_request' : body.error.issues[0]?.message });
    try {
      return reply.status(200).send(await savePartnerOperationCompensation(
        getPartnerContext(request), id.data.collaboratorId, body.data,
      ));
    } catch (error) { return bad(reply, error, 'partner compensation save failed'); }
  });

  fastify.get('/parceiro/:slug/api/equipe/:collaboratorId/comissao', { preHandler: owner }, async (request: PartnerAuthedRequest, reply) => {
    reply.header('Cache-Control', 'no-store'); const id = params.safeParse(request.params ?? {});
    if (!id.success) return reply.status(400).send({ error: 'invalid_request' });
    try {
      const payload = await getPartnerOperationCommissionRule(getPartnerContext(request), id.data.collaboratorId);
      return payload ? reply.status(200).send(payload) : reply.status(404).send({ error: 'collaborator_not_found' });
    } catch (error) { return bad(reply, error, 'partner commission rule unavailable'); }
  });

  fastify.put('/parceiro/:slug/api/equipe/:collaboratorId/comissao', { preHandler: owner }, async (request: PartnerAuthedRequest, reply) => {
    const id = params.safeParse(request.params ?? {}); const body = commission.safeParse(request.body ?? {});
    if (!id.success || !body.success) return reply.status(400).send({ error: body.success ? 'invalid_request' : body.error.issues[0]?.message });
    try {
      return reply.status(200).send(await savePartnerOperationCommissionRule(
        getPartnerContext(request), id.data.collaboratorId, body.data,
      ));
    } catch (error) { return bad(reply, error, 'partner commission rule save failed'); }
  });
}
