import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminOwner } from '../auth.js';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/logger.js';
import {
  addMatrizPayrollAdjustment, closeMatrizPayroll, getMatrizCollaboratorManagement,
  payMatrizPayrollItem, removeMatrizPayrollAdjustment,
  reviewMatrizPayrollCausalAdjustment,
  saveMatrizCollaboratorCompensation,
} from './queries.js';
import { operatorLabel } from './route-helpers.js';
import { saveMatrizOperationCommissionRule } from '../caixa/operation-team.js';
import {
  getMatrizOperationPermissions,
  saveMatrizOperationPermissions,
} from '../caixa/operation-team-permissions.js';
import { saveMatrizFinancialConfiguration } from './matriz-financial-configuration.js';
import { getMatrizTeamPerformance } from './queries-colaboradores-desempenho.js';

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-01$/);
const performanceRange = z.enum(['7d', '30d', 'month']);
const money = z.number().finite().min(0).max(10_000_000)
  .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-7,
    'money_cent_precision');
const positiveMoney = money.refine((value) => value > 0, 'amount_must_be_positive');
const benefits = z.array(z.object({
  name: z.string().trim().min(2).max(60), amount: money, active: z.boolean().default(true),
})).max(12).optional();
const safePaymentReference = z.string().trim().max(160).nullable().optional().refine((value) => {
  if (!value) return true;
  return !/@/.test(value) && !/\d{6,}/.test(value)
    && !/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i.test(value);
}, 'payment_reference_must_be_masked');
const compensationSchema = z.object({
  collaborator_id: z.string().uuid(), employment_type: z.enum(['clt', 'mei', 'autonomo', 'outro']),
  base_salary: money, salary_frequency: z.enum(['weekly', 'monthly']).optional(),
  payment_day: z.number().int().min(1).max(28),
  payment_method: z.enum(['pix', 'transferencia', 'dinheiro', 'outro']),
  payment_note: safePaymentReference, starts_on: z.string().date(), benefits,
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
const commissionSchema = z.object({
  collaborator_id: z.string().uuid(), kind: z.enum(['percent', 'fixed']),
  basis: z.enum(['margin', 'revenue', 'sale', 'delivery', 'trip']),
  value: money, starts_on: z.string().date(), active: z.boolean().default(true),
  settlement_frequency: z.enum(['weekly', 'monthly']).default('monthly'),
  itemized: z.boolean().default(false),
  item_rules: commissionItemRules.default({
    tire: { kind: 'none', value: 0 }, service: { kind: 'none', value: 0 },
    other: { kind: 'none', value: 0 },
  }),
}).superRefine((v, ctx) => {
  if (!v.itemized && v.kind === 'percent' && (!['margin', 'revenue'].includes(v.basis) || v.value > 100)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid_commission_rule' });
  }
  if (!v.itemized && v.kind === 'fixed' && !['sale', 'delivery', 'trip'].includes(v.basis)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid_commission_rule' });
  }
});
const financialConfigurationSchema = z.object({
  compensation: compensationSchema,
  commission: commissionSchema,
}).superRefine((value, ctx) => {
  if (value.compensation.collaborator_id !== value.commission.collaborator_id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'collaborator_mismatch' });
  }
});
const operationPermissions = z.object({
  resumo: z.boolean(), bot: z.boolean(), vendas: z.boolean(), retiradas: z.boolean(),
  clientes: z.boolean(), compras: z.boolean(), estoque: z.boolean(),
  logistica: z.boolean(), financeiro: z.boolean(), rede: z.boolean(),
  marketing: z.boolean(), colaboradores: z.boolean(), catalogo: z.boolean(),
}).strict();
const adjustmentSchema = z.object({
  collaborator_id: z.string().uuid(), competence: month,
  kind: z.enum(['addition', 'deduction']), description: z.string().trim().min(2).max(120),
  amount: positiveMoney,
});
const causalAdjustmentReviewSchema = z.object({
  id: z.string().uuid(), amount: positiveMoney,
});

function managementError(reply: any, err: unknown, label: string) {
  const message = err instanceof Error ? err.message : 'internal_server_error';
  const clientErrors = new Set([
    'collaborator_not_found', 'period_closed_or_collaborator_not_found',
    'adjustment_not_found_or_period_closed', 'nothing_to_close',
    'payroll_has_unresolved_adjustments', 'payroll_has_unresolved_costs',
    'payroll_has_unassigned_events',
    'payroll_competence_not_finished',
    'invalid_adjustment_amount', 'invalid_commission_basis',
  ]);
  if (clientErrors.has(message)) return reply.status(400).send({ error: message });
  if (message === 'collaborator_management_unavailable') {
    return reply.status(409).send({ error: message });
  }
  if (message === 'period_already_closed') return reply.status(409).send({ error: message });
  if (message === 'owner_permissions_locked') return reply.status(409).send({ error: message });
  if (['idempotency_conflict', 'idempotency_incomplete', 'payroll_payment_conflict'].includes(message)) {
    return reply.status(409).send({ error: message });
  }
  if (message === 'payroll_item_not_found' || message === 'payroll_expense_not_found') {
    return reply.status(404).send({ error: message });
  }
  if (message === 'causal_adjustment_not_found') return reply.status(404).send({ error: message });
  if (message === 'causal_adjustment_already_reviewed') return reply.status(409).send({ error: message });
  logger.error({ err }, label);
  return reply.status(500).send({ error: 'internal_server_error' });
}

export async function registerPainelColaboradoresGestao(fastify: FastifyInstance): Promise<void> {
  fastify.get('/admin/api/colaboradores/gestao', { preHandler: requireAdminOwner }, async (request, reply) => {
    const parsed = z.object({ competencia: month }).safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_competence' });
    try { return reply.status(200).send(await getMatrizCollaboratorManagement(parsed.data.competencia)); }
    catch (err) { return managementError(reply, err, 'collaborator management read failed'); }
  });

  fastify.get('/admin/api/colaboradores/desempenho', { preHandler: requireAdminOwner }, async (request, reply) => {
    const parsed = z.object({ range: performanceRange.default('month') }).safeParse(request.query ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_range' });
    reply.header('Cache-Control', 'no-store');
    try { return reply.status(200).send(await getMatrizTeamPerformance(parsed.data.range)); }
    catch (err) { return managementError(reply, err, 'collaborator performance read failed'); }
  });

  fastify.post('/admin/api/colaboradores/remuneracao', { preHandler: requireAdminOwner }, async (request, reply) => {
    const parsed = compensationSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    try {
      return reply.status(200).send(await saveMatrizCollaboratorCompensation({ ...parsed.data, actor_label: operatorLabel(request) }));
    } catch (err) { return managementError(reply, err, 'collaborator compensation save failed'); }
  });

  fastify.post('/admin/api/colaboradores/comissao', { preHandler: requireAdminOwner }, async (request, reply) => {
    const parsed = commissionSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    try {
      return reply.status(200).send(await saveMatrizOperationCommissionRule({ ...parsed.data, actor_label: operatorLabel(request) }));
    } catch (err) { return managementError(reply, err, 'collaborator commission save failed'); }
  });

  fastify.post('/admin/api/colaboradores/configuracao-financeira', {
    preHandler: requireAdminOwner,
  }, async (request, reply) => {
    const parsed = financialConfigurationSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    const actor = operatorLabel(request);
    try {
      return reply.status(200).send(await saveMatrizFinancialConfiguration(
        { ...parsed.data.compensation, actor_label: actor },
        { ...parsed.data.commission, actor_label: actor },
      ));
    } catch (err) { return managementError(reply, err, 'collaborator financial configuration save failed'); }
  });

  fastify.get('/admin/api/colaboradores/:collaboratorId/permissoes-operacao', {
    preHandler: requireAdminOwner,
  }, async (request, reply) => {
    const parsed = z.object({ collaboratorId: z.string().uuid() }).safeParse(request.params);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_request' });
    try {
      const payload = await getMatrizOperationPermissions(parsed.data.collaboratorId);
      return payload ? reply.status(200).send(payload) : reply.status(404).send({ error: 'collaborator_not_found' });
    } catch (err) { return managementError(reply, err, 'collaborator operation permissions read failed'); }
  });

  fastify.put('/admin/api/colaboradores/:collaboratorId/permissoes-operacao', {
    preHandler: requireAdminOwner,
  }, async (request, reply) => {
    const id = z.object({ collaboratorId: z.string().uuid() }).safeParse(request.params);
    const body = operationPermissions.safeParse(request.body);
    if (!id.success || !body.success) return reply.status(400).send({ error: 'invalid_request' });
    try {
      return reply.status(200).send(await saveMatrizOperationPermissions(
        id.data.collaboratorId, body.data, operatorLabel(request),
      ));
    } catch (err) { return managementError(reply, err, 'collaborator operation permissions save failed'); }
  });

  fastify.post('/admin/api/colaboradores/ajustes', { preHandler: requireAdminOwner }, async (request, reply) => {
    const parsed = adjustmentSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid_body' });
    try { return reply.status(201).send(await addMatrizPayrollAdjustment({ ...parsed.data, actor_label: operatorLabel(request) })); }
    catch (err) { return managementError(reply, err, 'payroll adjustment create failed'); }
  });

  fastify.post('/admin/api/colaboradores/ajustes/remover', { preHandler: requireAdminOwner }, async (request, reply) => {
    const parsed = z.object({ id: z.string().uuid(), competence: month }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body' });
    try { return reply.status(200).send(await removeMatrizPayrollAdjustment(parsed.data)); }
    catch (err) { return managementError(reply, err, 'payroll adjustment remove failed'); }
  });

  fastify.post('/admin/api/colaboradores/ajustes/causal/revisar', {
    preHandler: requireAdminOwner,
  }, async (request, reply) => {
    const parsed = causalAdjustmentReviewSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body' });
    try {
      return reply.status(200).send(await reviewMatrizPayrollCausalAdjustment({
        ...parsed.data, actor_label: operatorLabel(request),
      }));
    } catch (err) { return managementError(reply, err, 'causal payroll adjustment review failed'); }
  });

  fastify.post('/admin/api/colaboradores/folha/fechar', { preHandler: requireAdminOwner }, async (request, reply) => {
    if (!env.MATRIZ_EXPENSES) return reply.status(409).send({ error: 'expenses_disabled' });
    const parsed = z.object({ competence: month }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body' });
    try { return reply.status(201).send(await closeMatrizPayroll({ ...parsed.data, actor_label: operatorLabel(request) })); }
    catch (err) { return managementError(reply, err, 'payroll close failed'); }
  });

  fastify.post('/admin/api/colaboradores/folha/pagar', { preHandler: requireAdminOwner }, async (request, reply) => {
    const parsed = z.object({ item_id: z.string().uuid(), idempotency_key: z.string().min(8).max(200) }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body' });
    try { return reply.status(200).send(await payMatrizPayrollItem({ ...parsed.data, actor_label: operatorLabel(request) })); }
    catch (err) { return managementError(reply, err, 'payroll payment failed'); }
  });
}
