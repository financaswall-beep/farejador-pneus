import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import {
  benefitTotal, benefitsOf, commissionItemRulesOf, emptyCommissionItemRules, money,
  type OperationBenefit, type OperationCommissionBasis,
  type OperationCommissionItemRules,
  type OperationCommissionRulePayload, type OperationCompensationPayload,
  type OperationTeamMember, type OperationTeamPayload,
} from '../../shared/operation-team.js';
import {
  createMatrizCollaborator,
  getMatrizCollaboratorManagement,
  saveMatrizCollaboratorCommission,
  saveMatrizCollaboratorCompensation,
} from '../painel/queries.js';

type Queryable = Pick<Pool, 'query'>;

function localDate(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function competence(): string { return `${localDate().slice(0, 7)}-01`; }

function roleBases(workArea: string): OperationCommissionBasis[] {
  return workArea === 'delivery'
    ? ['delivery', 'trip']
    : ['revenue', 'margin', 'sale'];
}

function memberOf(row: Awaited<ReturnType<typeof getMatrizCollaboratorManagement>>['collaborators'][number]): OperationTeamMember {
  return {
    id: row.id, name: row.display_name, username: row.username,
    role: row.job_title || row.job || 'Colaborador', work_area: row.work_area,
    active: row.active, base_salary: money(row.monthly_base_salary),
    salary_frequency: row.salary_frequency ?? 'monthly',
    benefits_total: money(row.benefits_total), payment_day: row.payment_day,
    compensation_starts_on: row.compensation_starts_on,
    commission_kind: row.commission_kind, commission_basis: row.commission_basis,
    commission_value: money(row.commission_value), commission_active: row.commission_active,
    commission_amount: money(row.commission_amount),
  };
}

async function management(db: Queryable) {
  return getMatrizCollaboratorManagement(competence(), env.FAREJADOR_ENV, db);
}

async function findMember(id: string, db: Queryable) {
  const snapshot = await management(db);
  const source = snapshot.collaborators.find((row) => row.id === id);
  return source ? { source, member: memberOf(source) } : null;
}

export async function createMatrizOperationMember(input: {
  name: string; username: string; password: string;
  role: 'vendedor' | 'entregador' | 'administrativo'; actor_label: string;
}, db: Pool = defaultPool): Promise<{ id: string; username: string }> {
  const profile = input.role === 'vendedor'
    ? { job: 'vendedor' as const, job_title: 'Vendedor', work_area: 'sales' as const,
        permissions: { vendas: true, estoque: true, entregas: false, financeiro: false } }
    : input.role === 'entregador'
      ? { job: 'entregador' as const, job_title: 'Entregador', work_area: 'delivery' as const,
          permissions: { vendas: false, estoque: false, entregas: true, financeiro: false } }
      : { job: 'colaborador' as const, job_title: 'Administrativo', work_area: 'administrative' as const,
          permissions: { vendas: false, estoque: false, entregas: false, financeiro: false } };
  return createMatrizCollaborator({
    display_name: input.name, username: input.username, password: input.password,
    job: profile.job, job_title: profile.job_title, work_area: profile.work_area,
    panel_role: null, actor_label: input.actor_label,
    operation_permissions: profile.permissions,
  }, db);
}

export async function getMatrizOperationTeam(
  db: Queryable = defaultPool,
): Promise<OperationTeamPayload> {
  const snapshot = await management(db);
  const members = snapshot.collaborators.map(memberOf);
  return {
    unit_name: 'Matriz', active_count: members.filter((row) => row.active).length,
    commission_total: money(members.reduce((sum, row) => sum + row.commission_amount, 0)),
    members,
  };
}

export async function getMatrizOperationCompensation(
  collaboratorId: string,
  db: Queryable = defaultPool,
): Promise<OperationCompensationPayload | null> {
  const found = await findMember(collaboratorId, db);
  if (!found) return null;
  const benefits = benefitsOf(found.source.benefits);
  const total = benefitTotal(benefits);
  return {
    unit_name: 'Matriz', member: found.member,
    employment_type: (found.source.employment_type as OperationCompensationPayload['employment_type']) || 'outro',
    base_salary: money(found.source.monthly_base_salary),
    salary_frequency: found.source.salary_frequency ?? 'monthly', payment_day: found.source.payment_day ?? 5,
    payment_method: (found.source.payment_method as OperationCompensationPayload['payment_method']) || 'pix',
    starts_on: found.source.compensation_starts_on || localDate(), benefits,
    benefits_total: total, fixed_total: money(found.source.monthly_base_salary + total),
  };
}

export async function saveMatrizOperationCompensation(input: {
  collaborator_id: string; employment_type: OperationCompensationPayload['employment_type'];
  base_salary: number; salary_frequency: OperationCompensationPayload['salary_frequency'];
  payment_day: number; payment_method: OperationCompensationPayload['payment_method'];
  starts_on: string; benefits: OperationBenefit[]; actor_label: string;
}, db: Pool = defaultPool): Promise<OperationCompensationPayload> {
  await saveMatrizCollaboratorCompensation({
    ...input, environment: env.FAREJADOR_ENV, payment_note: null,
  }, db);
  const saved = await getMatrizOperationCompensation(input.collaborator_id, db);
  if (!saved) throw new Error('collaborator_not_found');
  return saved;
}

export async function getMatrizOperationCommissionRule(
  collaboratorId: string,
  db: Queryable = defaultPool,
): Promise<OperationCommissionRulePayload | null> {
  const found = await findMember(collaboratorId, db);
  if (!found) return null;
  const available = roleBases(found.source.work_area);
  const fallback = available[0] ?? 'revenue';
  const history = await db.query<{
    kind: 'percent' | 'fixed'; basis: OperationCommissionBasis;
    value: string; active: boolean; starts_on: string; itemized: boolean; item_rules: unknown;
    settlement_frequency: 'weekly' | 'monthly';
  }>(`SELECT kind,basis,value::text,active,starts_on::text,itemized,item_rules,
             settlement_frequency
        FROM network.matriz_collaborator_commission_rules
       WHERE environment=$1 AND collaborator_id=$2
       ORDER BY starts_on DESC,updated_at DESC LIMIT 24`, [env.FAREJADOR_ENV, collaboratorId]);
  return {
    unit_name: 'Matriz', member: found.member,
    kind: found.source.commission_kind ?? (fallback === 'revenue' ? 'percent' : 'fixed'),
    basis: found.source.commission_basis ?? fallback,
    value: money(found.source.commission_value), active: found.source.commission_active,
    starts_on: found.source.commission_starts_on || localDate(), available_bases: available,
    itemized: found.source.commission_itemized,
    item_rules: found.source.commission_item_rules ?? emptyCommissionItemRules(),
    settlement_frequency: found.source.commission_settlement_frequency ?? 'monthly',
    history: history.rows.map((row) => ({ ...row, value: money(row.value),
      item_rules: commissionItemRulesOf(row.item_rules) })),
  };
}

export async function saveMatrizOperationCommissionRule(input: {
  collaborator_id: string; kind: 'percent' | 'fixed'; basis: OperationCommissionBasis;
  value: number; active: boolean; starts_on: string; actor_label: string;
  itemized: boolean; item_rules: OperationCommissionItemRules;
  settlement_frequency: 'weekly' | 'monthly';
}, db: Pool = defaultPool): Promise<OperationCommissionRulePayload> {
  const found = await findMember(input.collaborator_id, db);
  const salesRule = input.itemized && found?.source.work_area !== 'delivery';
  if (!found || (input.itemized && !salesRule)
      || (!input.itemized && !roleBases(found.source.work_area).includes(input.basis))) {
    throw new Error('invalid_commission_basis');
  }
  const rules = commissionItemRulesOf(input.item_rules);
  const representative = (['tire', 'service', 'other'] as const)
    .map((group) => rules[group]).find((rule) => rule.kind !== 'none' && rule.value > 0);
  const compatibility = salesRule
    ? {
        kind: representative?.kind === 'fixed' ? 'fixed' as const : 'percent' as const,
        basis: representative?.kind === 'fixed' ? 'sale' as const : 'revenue' as const,
        value: representative?.value ?? 0,
        active: Boolean(representative) && input.active,
      }
    : { kind: input.kind, basis: input.basis, value: input.value, active: input.active };
  await saveMatrizCollaboratorCommission({
    ...input, ...compatibility, itemized: salesRule, item_rules: salesRule ? rules : emptyCommissionItemRules(),
    environment: env.FAREJADOR_ENV,
  }, db);
  const saved = await getMatrizOperationCommissionRule(input.collaborator_id, db);
  if (!saved) throw new Error('collaborator_not_found');
  return saved;
}
