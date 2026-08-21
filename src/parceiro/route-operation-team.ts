import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { logger } from '../shared/logger.js';
import { getPartnerContext, requireOwner, requirePartnerAuth, type PartnerAuthedRequest } from './auth.js';
import {
  getPartnerOperationCommissionRule, getPartnerOperationCompensation,
  getPartnerOperationTeam, savePartnerOperationCommissionRule,
  savePartnerOperationCompensation,
} from './operation-team.js';
import { createPartnerOperationMember } from './operation-team-create.js';
import {
  getPartnerOperationPermissions,
  savePartnerOperationPermissions,
} from './operation-team-permissions.js';
import { savePartnerOperationConfiguration } from './operation-team-config.js';

const owner = [requirePartnerAuth, requireOwner];
const params = z.object({ collaboratorId: z.string().uuid() });
const centMoney = (maximum: number) => z.number().finite().min(0).max(maximum)
  .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-7,
    'money_cent_precision');
const money = centMoney(10_000_000);
const percentMoney = centMoney(100);
// Configuracao e agenda, nao fato transacional: pode ser programada para o futuro.
const startsOn = z.string().date();
const benefits = z.array(z.object({
  name: z.string().trim().min(2).max(60), amount: money, active: z.boolean().default(true),
})).max(12);
const compensation = z.object({
  employment_type: z.enum(['clt', 'mei', 'autonomo', 'outro']), base_salary: money,
  salary_frequency: z.enum(['weekly', 'monthly']).default('monthly'),
  payment_day: z.number().int().min(1).max(28),
  payment_method: z.enum(['pix', 'transferencia', 'dinheiro', 'outro']),
  starts_on: startsOn, benefits,
});
const commissionItemRule = z.object({
  kind: z.enum(['percent', 'fixed', 'none']), value: money,
});
const commissionItemRules = z.object({
  tire: commissionItemRule,
  service: commissionItemRule,
  other: commissionItemRule,
}).superRefine((rules, ctx) => {
  if (rules.service.kind === 'fixed' || rules.other.kind === 'fixed'
      || Object.values(rules).some((rule) => rule.kind === 'percent' && rule.value > 100)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid_commission_item_rules' });
  }
});
const itemizedFields = {
  settlement_frequency: z.enum(['weekly', 'monthly']).default('monthly'),
  itemized: z.boolean().default(false),
  item_rules: commissionItemRules.default({
    tire: { kind: 'none' as const, value: 0 }, service: { kind: 'none' as const, value: 0 },
    other: { kind: 'none' as const, value: 0 },
  }),
};
const commission = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('percent'), basis: z.literal('revenue'), value: percentMoney, active: z.boolean(), starts_on: startsOn, ...itemizedFields }),
  z.object({ kind: z.literal('fixed'), basis: z.literal('sale'), value: money, active: z.boolean(), starts_on: startsOn, ...itemizedFields }),
]);
const permissions = z.object({
  vendas: z.boolean(), estoque: z.boolean(), pedidos: z.boolean(), clientes: z.boolean(),
  entregas: z.boolean(), retiradas: z.boolean(), batepapo: z.boolean().default(false),
  resumo: z.boolean(), financeiro: z.boolean(),
});
const newMember = z.object({
  name: z.string().trim().min(2).max(120),
  username: z.string().trim().min(3).max(60)
    .regex(/^[a-zA-Z0-9._-]+$/, 'usuario_invalido'),
  password: z.string().min(12).max(200),
  role: z.enum(['vendedor', 'estoque', 'entregador', 'colaborador']),
});
const configuration = z.object({
  job_role: z.enum(['vendedor', 'estoque', 'entregador', 'colaborador']),
  permissions,
  compensation,
  commission,
});

function bad(reply: FastifyReply, error: unknown, label: string) {
  const code = error instanceof Error ? error.message : 'team_unavailable';
  if (code === 'collaborator_not_found') return reply.status(404).send({ error: code });
  if (code === 'username_taken') return reply.status(409).send({ error: code });
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

  fastify.post('/parceiro/:slug/api/equipe', { preHandler: owner }, async (request: PartnerAuthedRequest, reply) => {
    const body = newMember.safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: body.error.issues[0]?.message ?? 'invalid_request' });
    try {
      const created = await createPartnerOperationMember(getPartnerContext(request), body.data);
      return reply.status(201).send({ created: true, ...created });
    } catch (error) { return bad(reply, error, 'partner operation member create failed'); }
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

  fastify.get('/parceiro/:slug/api/equipe/:collaboratorId/permissoes', { preHandler: owner }, async (request: PartnerAuthedRequest, reply) => {
    reply.header('Cache-Control', 'no-store'); const id = params.safeParse(request.params ?? {});
    if (!id.success) return reply.status(400).send({ error: 'invalid_request' });
    try {
      const payload = await getPartnerOperationPermissions(getPartnerContext(request), id.data.collaboratorId);
      return payload ? reply.status(200).send(payload) : reply.status(404).send({ error: 'collaborator_not_found' });
    } catch (error) { return bad(reply, error, 'partner operation permissions unavailable'); }
  });

  fastify.put('/parceiro/:slug/api/equipe/:collaboratorId/configuracao', { preHandler: owner }, async (request: PartnerAuthedRequest, reply) => {
    const id = params.safeParse(request.params ?? {});
    const body = configuration.safeParse(request.body ?? {});
    if (!id.success || !body.success) {
      return reply.status(400).send({ error: body.success ? 'invalid_request' : body.error.issues[0]?.message });
    }
    try {
      return reply.status(200).send(await savePartnerOperationConfiguration(
        getPartnerContext(request), id.data.collaboratorId, body.data,
      ));
    } catch (error) { return bad(reply, error, 'partner operation configuration save failed'); }
  });

  fastify.put('/parceiro/:slug/api/equipe/:collaboratorId/permissoes', { preHandler: owner }, async (request: PartnerAuthedRequest, reply) => {
    const id = params.safeParse(request.params ?? {}); const body = permissions.safeParse(request.body ?? {});
    if (!id.success || !body.success) return reply.status(400).send({ error: 'invalid_request' });
    try {
      return reply.status(200).send(await savePartnerOperationPermissions(
        getPartnerContext(request), id.data.collaboratorId, body.data,
      ));
    } catch (error) { return bad(reply, error, 'partner operation permissions save failed'); }
  });
}
