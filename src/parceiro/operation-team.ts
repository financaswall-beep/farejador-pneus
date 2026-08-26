import type { Pool } from 'pg';
import { pool as defaultPool } from '../persistence/db.js';
import {
  benefitTotal, benefitsOf, commissionItemRulesOf, emptyCommissionItemRules, money,
  type OperationBenefit, type OperationCommissionRulePayload,
  type OperationCommissionItemRules,
  type OperationCompensationPayload, type OperationTeamMember, type OperationTeamPayload,
} from '../shared/operation-team.js';
import type { PartnerContext } from './auth.js';

type Queryable = Pick<Pool, 'query'>;

export interface PartnerCompensationInput {
  employment_type: OperationCompensationPayload['employment_type']; base_salary: number;
  salary_frequency: OperationCompensationPayload['salary_frequency'];
  payment_day: number; payment_method: OperationCompensationPayload['payment_method'];
  starts_on: string; benefits: OperationBenefit[];
}

export interface PartnerCommissionRuleInput {
  kind: 'percent' | 'fixed'; basis: 'revenue' | 'sale'; value: number; active: boolean;
  starts_on: string; itemized: boolean; item_rules: OperationCommissionItemRules;
  settlement_frequency: 'weekly' | 'monthly';
}

type PartnerMemberRow = {
  id: string; name: string; username: string | null; active: boolean; role_name: string;
  job_role: 'vendedor' | 'estoque' | 'entregador' | 'colaborador';
  base_salary: string; salary_frequency: 'weekly' | 'monthly';
  payment_day: number | null; starts_on: string | null;
  benefits: unknown; commission_kind: 'percent' | 'fixed' | null;
  commission_value: string; commission_active: boolean; commission_starts_on: string | null;
  commission_amount: string;
  permissions: Partial<Record<
    'vendas' | 'estoque' | 'pedidos' | 'clientes' | 'entregas'
    | 'retiradas' | 'batepapo' | 'resumo' | 'financeiro', boolean
  >>;
};

function localDate(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function memberOf(row: PartnerMemberRow): OperationTeamMember {
  const benefits = benefitsOf(row.benefits);
  const jobRole = row.job_role ?? (row.role_name === 'Vendedor' ? 'vendedor'
    : row.role_name === 'Entregador' ? 'entregador'
      : row.role_name === 'Estoque' ? 'estoque' : 'colaborador');
  return {
    id: row.id, name: row.name, username: row.username, role: row.role_name,
    work_area: jobRole === 'entregador' ? 'delivery'
      : jobRole === 'estoque' ? 'stock'
        : jobRole === 'vendedor' ? 'sales' : 'other', active: row.active,
    base_salary: money(row.base_salary), salary_frequency: row.salary_frequency ?? 'monthly',
    benefits_total: benefitTotal(benefits),
    payment_day: row.payment_day, compensation_starts_on: row.starts_on,
    commission_kind: row.commission_kind,
    commission_basis: row.commission_kind === 'fixed' ? 'sale' : 'revenue',
    commission_value: money(row.commission_value), commission_active: row.commission_active,
    commission_amount: money(row.commission_amount),
    permissions: row.permissions ?? {},
  };
}

async function rows(ctx: PartnerContext, db: Queryable): Promise<PartnerMemberRow[]> {
  const result = await db.query<PartnerMemberRow>(
    `SELECT pat.id,COALESCE(NULLIF(btrim(pat.label),''),pat.login_username,'Colaborador') name,
            pat.login_username username,pat.revoked_at IS NULL active,pat.job_role,
            CASE pat.job_role WHEN 'vendedor' THEN 'Vendedor' WHEN 'estoque' THEN 'Estoque'
                 WHEN 'entregador' THEN 'Entregador' ELSE 'Colaborador' END role_name,
            COALESCE(comp.base_salary,0)::text base_salary,
            COALESCE(comp.salary_frequency,'monthly') salary_frequency,comp.payment_day,
            comp.starts_on,COALESCE(comp.benefits,'[]'::jsonb) benefits,
            COALESCE(hist.kind,legacy.kind) commission_kind,
            COALESCE(hist.value,legacy.value,0)::text commission_value,
            COALESCE(hist.active,legacy.active,false) commission_active,hist.starts_on commission_starts_on,
              COALESCE(facts.commission_amount,0)::text commission_amount,
              jsonb_build_object(
              'vendas',COALESCE(perms.allow_vendas,false),
              'estoque',COALESCE(perms.allow_estoque,false),
              'pedidos',COALESCE(perms.allow_pedidos,false),
              'clientes',COALESCE(perms.allow_clientes,false),
              'entregas',COALESCE(perms.allow_entregas,false),
              'retiradas',COALESCE(perms.allow_retiradas,false),
              'batepapo',COALESCE(perms.allow_batepapo,false),
              'resumo',COALESCE(perms.allow_resumo,false),
              'financeiro',COALESCE(perms.allow_financeiro,false)
            ) permissions
       FROM network.partner_access_tokens pat
       LEFT JOIN network.partner_token_permissions perms
         ON perms.environment=pat.environment AND perms.partner_unit_id=pat.partner_unit_id
        AND perms.token_id=pat.id
       LEFT JOIN LATERAL (
         SELECT c.* FROM network.partner_collaborator_compensation c
          WHERE c.environment=pat.environment AND c.token_id=pat.id
            AND c.starts_on<=(now() AT TIME ZONE 'America/Sao_Paulo')::date
          ORDER BY c.starts_on DESC LIMIT 1
       ) comp ON true
       LEFT JOIN network.partner_token_commission legacy
         ON legacy.environment=pat.environment AND legacy.token_id=pat.id
       LEFT JOIN LATERAL (
         SELECT h.kind,h.value,h.active,h.starts_on FROM network.partner_token_commission_history h
          WHERE h.environment=pat.environment AND h.token_id=pat.id
            AND h.starts_on<=(now() AT TIME ZONE 'America/Sao_Paulo')::date
          ORDER BY h.starts_on DESC,h.updated_at DESC LIMIT 1
       ) hist ON true
       LEFT JOIN LATERAL (
         SELECT COALESCE(sum(x.amount),0) commission_amount FROM (
           SELECT ce.commission_amount amount
             FROM finance.partner_staff_commission_entries ce
            WHERE ce.environment=pat.environment AND ce.token_id=pat.id AND ce.status='earned'
              AND ce.competence_month=date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')::date
           UNION ALL
           SELECT ca.amount FROM finance.partner_staff_commission_adjustments ca
            WHERE ca.environment=pat.environment AND ca.token_id=pat.id
              AND ca.competence_month=date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')::date
         ) x
       ) facts ON true
      WHERE pat.environment=$1 AND pat.partner_unit_id=$2 AND pat.role='funcionario'
      ORDER BY pat.revoked_at IS NOT NULL,name`,
    [ctx.environment, ctx.partnerUnitId],
  );
  return result.rows;
}

async function find(ctx: PartnerContext, id: string, db: Queryable) {
  return (await rows(ctx, db)).find((row) => row.id === id) ?? null;
}

export async function getPartnerOperationTeam(ctx: PartnerContext, db: Queryable = defaultPool): Promise<OperationTeamPayload> {
  const members = (await rows(ctx, db)).map(memberOf);
  return {
    unit_name: ctx.unitName, active_count: members.filter((row) => row.active).length,
    commission_total: money(members.reduce((sum, row) => sum + row.commission_amount, 0)), members,
  };
}

export async function getPartnerOperationCompensation(
  ctx: PartnerContext, tokenId: string, db: Queryable = defaultPool,
): Promise<OperationCompensationPayload | null> {
  const row = await find(ctx, tokenId, db); if (!row) return null;
  const detail = await db.query<{
    employment_type: OperationCompensationPayload['employment_type'];
    payment_method: OperationCompensationPayload['payment_method'];
    salary_frequency: OperationCompensationPayload['salary_frequency'];
    base_salary: string; payment_day: number; starts_on: string; benefits: unknown;
  }>(
    `SELECT employment_type,payment_method,salary_frequency,base_salary::text,
            payment_day,starts_on::text,benefits
       FROM network.partner_collaborator_compensation
      WHERE environment=$1 AND partner_unit_id=$2 AND token_id=$3
      ORDER BY starts_on DESC LIMIT 1`, [ctx.environment, ctx.partnerUnitId, tokenId],
  );
  const configured = detail.rows[0];
  const benefits = benefitsOf(configured?.benefits ?? row.benefits);
  const total = benefitTotal(benefits);
  const baseSalary = money(configured?.base_salary ?? row.base_salary);
  return {
    unit_name: ctx.unitName, member: memberOf(row), employment_type: configured?.employment_type ?? 'outro',
    base_salary: baseSalary, salary_frequency: configured?.salary_frequency ?? 'monthly',
    payment_day: configured?.payment_day ?? 5,
    payment_method: configured?.payment_method ?? 'pix', starts_on: configured?.starts_on || localDate(), benefits,
    benefits_total: total, fixed_total: money(baseSalary + total),
  };
}

export async function savePartnerOperationCompensation(ctx: PartnerContext, tokenId: string, input: {
  employment_type: OperationCompensationPayload['employment_type']; base_salary: number;
  salary_frequency: OperationCompensationPayload['salary_frequency'];
  payment_day: number; payment_method: OperationCompensationPayload['payment_method'];
  starts_on: string; benefits: OperationBenefit[];
}, db: Pool = defaultPool): Promise<OperationCompensationPayload> {
  await writePartnerOperationCompensation(ctx, tokenId, input, db);
  const saved = await getPartnerOperationCompensation(ctx, tokenId, db);
  if (!saved) throw new Error('collaborator_not_found'); return saved;
}

export async function writePartnerOperationCompensation(
  ctx: PartnerContext, tokenId: string, input: PartnerCompensationInput, db: Queryable,
): Promise<void> {
  const result = await db.query(
    `INSERT INTO network.partner_collaborator_compensation
       (environment,partner_unit_id,token_id,employment_type,base_salary,salary_frequency,payment_day,
        payment_method,starts_on,benefits,updated_by)
     SELECT pat.environment,pat.partner_unit_id,pat.id,$4,$5,$6,$7,$8,$9::date,$10::jsonb,$11
       FROM network.partner_access_tokens pat
      WHERE pat.environment=$1 AND pat.partner_unit_id=$2 AND pat.id=$3
        AND pat.role='funcionario' AND pat.revoked_at IS NULL
     ON CONFLICT (token_id,starts_on) DO UPDATE SET employment_type=EXCLUDED.employment_type,
       base_salary=EXCLUDED.base_salary,salary_frequency=EXCLUDED.salary_frequency,
       payment_day=EXCLUDED.payment_day,
       payment_method=EXCLUDED.payment_method,benefits=EXCLUDED.benefits,
       updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING id`,
    [ctx.environment, ctx.partnerUnitId, tokenId, input.employment_type, input.base_salary,
     input.salary_frequency, input.payment_day, input.payment_method, input.starts_on,
     JSON.stringify(input.benefits), `owner:${ctx.slug}`],
  );
  if (!result.rows[0]) throw new Error('collaborator_not_found');
}

export async function getPartnerOperationCommissionRule(
  ctx: PartnerContext, tokenId: string, db: Queryable = defaultPool,
): Promise<OperationCommissionRulePayload | null> {
  const row = await find(ctx, tokenId, db); if (!row) return null;
  const history = await db.query<{
    kind: 'percent' | 'fixed'; value: string; active: boolean; starts_on: string;
    itemized: boolean; item_rules: unknown; settlement_frequency: 'weekly' | 'monthly';
  }>(`SELECT kind,value::text,active,starts_on::text,itemized,item_rules,
             settlement_frequency
        FROM network.partner_token_commission_history
       WHERE environment=$1 AND partner_unit_id=$2 AND token_id=$3
       ORDER BY starts_on DESC,updated_at DESC LIMIT 24`,
  [ctx.environment, ctx.partnerUnitId, tokenId]);
  const config = await db.query<{ itemized: boolean; item_rules: unknown; settlement_frequency: 'weekly' | 'monthly' }>(
    `SELECT itemized,item_rules,settlement_frequency FROM network.partner_token_commission
      WHERE environment=$1 AND partner_unit_id=$2 AND token_id=$3`,
    [ctx.environment, ctx.partnerUnitId, tokenId],
  );
  const latest = history.rows[0];
  return {
    unit_name: ctx.unitName, member: memberOf(row), kind: latest?.kind ?? row.commission_kind ?? 'percent',
    basis: (latest?.kind ?? row.commission_kind) === 'fixed' ? 'sale' : 'revenue',
    value: money(latest?.value ?? row.commission_value),
    active: latest?.active ?? row.commission_active, starts_on: latest?.starts_on || localDate(),
    itemized: Boolean(latest?.itemized ?? config.rows[0]?.itemized),
    item_rules: commissionItemRulesOf(latest?.item_rules ?? config.rows[0]?.item_rules),
    settlement_frequency: latest?.settlement_frequency ?? config.rows[0]?.settlement_frequency ?? 'monthly',
    available_bases: ['revenue', 'sale'],
    history: history.rows.map((item) => ({
      ...item, value: money(item.value), basis: item.kind === 'fixed' ? 'sale' : 'revenue',
      item_rules: commissionItemRulesOf(item.item_rules),
    })),
  };
}

export async function savePartnerOperationCommissionRule(ctx: PartnerContext, tokenId: string, input: {
  kind: 'percent' | 'fixed'; basis: 'revenue' | 'sale'; value: number; active: boolean; starts_on: string;
  itemized: boolean; item_rules: OperationCommissionItemRules;
  settlement_frequency: 'weekly' | 'monthly';
}, db: Pool = defaultPool): Promise<OperationCommissionRulePayload> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await writePartnerOperationCommissionRule(ctx, tokenId, input, client);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
  const saved = await getPartnerOperationCommissionRule(ctx, tokenId, db);
  if (!saved) throw new Error('collaborator_not_found'); return saved;
}

export async function writePartnerOperationCommissionRule(
  ctx: PartnerContext, tokenId: string, input: PartnerCommissionRuleInput, db: Queryable,
): Promise<void> {
  if (!input.itemized && ((input.kind === 'percent' && input.basis !== 'revenue') || (input.kind === 'fixed' && input.basis !== 'sale'))) {
    throw new Error('invalid_commission_basis');
  }
  const rules = input.itemized ? commissionItemRulesOf(input.item_rules) : emptyCommissionItemRules();
  const representative = (['tire', 'service', 'other'] as const)
    .map((group) => rules[group]).find((rule) => rule.kind !== 'none' && rule.value > 0);
  const compatibility = input.itemized ? {
    kind: representative?.kind === 'fixed' ? 'fixed' as const : 'percent' as const,
    value: representative?.value ?? 0,
    active: Boolean(representative) && input.active,
  } : { kind: input.kind, value: input.value, active: input.active };
  const member = await db.query(`SELECT 1 FROM network.partner_access_tokens
      WHERE environment=$1 AND partner_unit_id=$2 AND id=$3 AND role='funcionario' AND revoked_at IS NULL FOR UPDATE`,
    [ctx.environment, ctx.partnerUnitId, tokenId]);
  if (!member.rows[0]) throw new Error('collaborator_not_found');
  await db.query(`INSERT INTO network.partner_token_commission_history
      (environment,partner_unit_id,token_id,kind,value,active,starts_on,updated_by,
       itemized,item_rules,settlement_frequency)
      VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8,$9,$10::jsonb,$11)
      ON CONFLICT (token_id,starts_on) DO UPDATE SET kind=EXCLUDED.kind,value=EXCLUDED.value,
        active=EXCLUDED.active,itemized=EXCLUDED.itemized,item_rules=EXCLUDED.item_rules,
        settlement_frequency=EXCLUDED.settlement_frequency,
        updated_by=EXCLUDED.updated_by,updated_at=now()`,
    [ctx.environment, ctx.partnerUnitId, tokenId, compatibility.kind, compatibility.value,
     compatibility.active, input.starts_on, `owner:${ctx.slug}`, input.itemized, JSON.stringify(rules),
     input.settlement_frequency]);
  await db.query(`INSERT INTO network.partner_token_commission
      (token_id,environment,partner_unit_id,kind,value,active,updated_by,itemized,item_rules,
       settlement_frequency)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) ON CONFLICT (token_id) DO UPDATE SET
      kind=EXCLUDED.kind,value=EXCLUDED.value,active=EXCLUDED.active,itemized=EXCLUDED.itemized,
      item_rules=EXCLUDED.item_rules,settlement_frequency=EXCLUDED.settlement_frequency,
      updated_at=now(),updated_by=EXCLUDED.updated_by`,
    [tokenId, ctx.environment, ctx.partnerUnitId, compatibility.kind, compatibility.value,
     compatibility.active, `owner:${ctx.slug}`, input.itemized, JSON.stringify(rules),
     input.settlement_frequency]);
}
