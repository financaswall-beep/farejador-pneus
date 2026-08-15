import type { Pool } from 'pg';
import { pool as defaultPool } from '../persistence/db.js';
import {
  benefitTotal, benefitsOf, money,
  type OperationBenefit, type OperationCommissionRulePayload,
  type OperationCompensationPayload, type OperationTeamMember, type OperationTeamPayload,
} from '../shared/operation-team.js';
import type { PartnerContext } from './auth.js';

type Queryable = Pick<Pool, 'query'>;

type PartnerMemberRow = {
  id: string; name: string; username: string | null; active: boolean; role_name: string;
  base_salary: string; payment_day: number | null; starts_on: string | null;
  benefits: unknown; commission_kind: 'percent' | 'fixed' | null;
  commission_value: string; commission_active: boolean; commission_starts_on: string | null;
  commission_amount: string;
};

function localDate(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function memberOf(row: PartnerMemberRow): OperationTeamMember {
  const benefits = benefitsOf(row.benefits);
  return {
    id: row.id, name: row.name, username: row.username, role: row.role_name,
    work_area: row.role_name === 'Entregador' ? 'delivery' : 'sales', active: row.active,
    base_salary: money(row.base_salary), benefits_total: benefitTotal(benefits),
    payment_day: row.payment_day, compensation_starts_on: row.starts_on,
    commission_kind: row.commission_kind,
    commission_basis: row.commission_kind === 'fixed' ? 'sale' : 'revenue',
    commission_value: money(row.commission_value), commission_active: row.commission_active,
    commission_amount: money(row.commission_amount),
  };
}

async function rows(ctx: PartnerContext, db: Queryable): Promise<PartnerMemberRow[]> {
  const result = await db.query<PartnerMemberRow>(
    `SELECT pat.id,COALESCE(NULLIF(btrim(pat.label),''),pat.login_username,'Colaborador') name,
            pat.login_username username,pat.revoked_at IS NULL active,
            CASE WHEN COALESCE(ptp.allow_entregas,pup.allow_entregas,true)
                       AND NOT COALESCE(ptp.allow_vendas,pup.allow_vendas,true) THEN 'Entregador'
                 WHEN COALESCE(ptp.allow_vendas,pup.allow_vendas,true) THEN 'Vendedor'
                 ELSE 'Colaborador' END role_name,
            COALESCE(comp.base_salary,0)::text base_salary,comp.payment_day,
            comp.starts_on,COALESCE(comp.benefits,'[]'::jsonb) benefits,
            cfg.kind commission_kind,COALESCE(cfg.value,0)::text commission_value,
            COALESCE(cfg.active,false) commission_active,hist.starts_on commission_starts_on,
            COALESCE(facts.commission_amount,0)::text commission_amount
       FROM network.partner_access_tokens pat
       LEFT JOIN network.partner_token_permissions ptp
         ON ptp.environment=pat.environment AND ptp.token_id=pat.id
       LEFT JOIN network.partner_unit_permissions pup
         ON pup.environment=pat.environment AND pup.partner_unit_id=pat.partner_unit_id
       LEFT JOIN LATERAL (
         SELECT c.* FROM network.partner_collaborator_compensation c
          WHERE c.environment=pat.environment AND c.token_id=pat.id
            AND c.starts_on<=current_date ORDER BY c.starts_on DESC LIMIT 1
       ) comp ON true
       LEFT JOIN network.partner_token_commission cfg
         ON cfg.environment=pat.environment AND cfg.token_id=pat.id
       LEFT JOIN LATERAL (
         SELECT h.starts_on FROM network.partner_token_commission_history h
          WHERE h.environment=pat.environment AND h.token_id=pat.id
          ORDER BY h.starts_on DESC LIMIT 1
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
  const benefits = benefitsOf(row.benefits); const total = benefitTotal(benefits);
  const detail = await db.query<{ employment_type: OperationCompensationPayload['employment_type']; payment_method: OperationCompensationPayload['payment_method'] }>(
    `SELECT employment_type,payment_method FROM network.partner_collaborator_compensation
      WHERE environment=$1 AND partner_unit_id=$2 AND token_id=$3 AND starts_on<=current_date
      ORDER BY starts_on DESC LIMIT 1`, [ctx.environment, ctx.partnerUnitId, tokenId],
  );
  return {
    unit_name: ctx.unitName, member: memberOf(row), employment_type: detail.rows[0]?.employment_type ?? 'outro',
    base_salary: money(row.base_salary), payment_day: row.payment_day ?? 5,
    payment_method: detail.rows[0]?.payment_method ?? 'pix', starts_on: row.starts_on || localDate(), benefits,
    benefits_total: total, fixed_total: money(money(row.base_salary) + total),
  };
}

export async function savePartnerOperationCompensation(ctx: PartnerContext, tokenId: string, input: {
  employment_type: OperationCompensationPayload['employment_type']; base_salary: number;
  payment_day: number; payment_method: OperationCompensationPayload['payment_method'];
  starts_on: string; benefits: OperationBenefit[];
}, db: Pool = defaultPool): Promise<OperationCompensationPayload> {
  const result = await db.query(
    `INSERT INTO network.partner_collaborator_compensation
       (environment,partner_unit_id,token_id,employment_type,base_salary,payment_day,
        payment_method,starts_on,benefits,updated_by)
     SELECT pat.environment,pat.partner_unit_id,pat.id,$4,$5,$6,$7,$8::date,$9::jsonb,$10
       FROM network.partner_access_tokens pat
      WHERE pat.environment=$1 AND pat.partner_unit_id=$2 AND pat.id=$3
        AND pat.role='funcionario' AND pat.revoked_at IS NULL
     ON CONFLICT (token_id,starts_on) DO UPDATE SET employment_type=EXCLUDED.employment_type,
       base_salary=EXCLUDED.base_salary,payment_day=EXCLUDED.payment_day,
       payment_method=EXCLUDED.payment_method,benefits=EXCLUDED.benefits,
       updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING id`,
    [ctx.environment, ctx.partnerUnitId, tokenId, input.employment_type, input.base_salary,
     input.payment_day, input.payment_method, input.starts_on, JSON.stringify(input.benefits), `owner:${ctx.slug}`],
  );
  if (!result.rows[0]) throw new Error('collaborator_not_found');
  const saved = await getPartnerOperationCompensation(ctx, tokenId, db);
  if (!saved) throw new Error('collaborator_not_found'); return saved;
}

export async function getPartnerOperationCommissionRule(
  ctx: PartnerContext, tokenId: string, db: Queryable = defaultPool,
): Promise<OperationCommissionRulePayload | null> {
  const row = await find(ctx, tokenId, db); if (!row) return null;
  const history = await db.query<{
    kind: 'percent' | 'fixed'; value: string; active: boolean; starts_on: string;
  }>(`SELECT kind,value::text,active,starts_on::text
        FROM network.partner_token_commission_history
       WHERE environment=$1 AND partner_unit_id=$2 AND token_id=$3
       ORDER BY starts_on DESC,updated_at DESC LIMIT 24`,
  [ctx.environment, ctx.partnerUnitId, tokenId]);
  return {
    unit_name: ctx.unitName, member: memberOf(row), kind: row.commission_kind ?? 'percent',
    basis: row.commission_kind === 'fixed' ? 'sale' : 'revenue', value: money(row.commission_value),
    active: row.commission_active, starts_on: row.commission_starts_on || localDate(),
    available_bases: ['revenue', 'sale'],
    history: history.rows.map((item) => ({
      ...item, value: money(item.value), basis: item.kind === 'fixed' ? 'sale' : 'revenue',
    })),
  };
}

export async function savePartnerOperationCommissionRule(ctx: PartnerContext, tokenId: string, input: {
  kind: 'percent' | 'fixed'; basis: 'revenue' | 'sale'; value: number; active: boolean; starts_on: string;
}, db: Pool = defaultPool): Promise<OperationCommissionRulePayload> {
  if ((input.kind === 'percent' && input.basis !== 'revenue') || (input.kind === 'fixed' && input.basis !== 'sale')) {
    throw new Error('invalid_commission_basis');
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const member = await client.query(`SELECT 1 FROM network.partner_access_tokens
      WHERE environment=$1 AND partner_unit_id=$2 AND id=$3 AND role='funcionario' AND revoked_at IS NULL FOR UPDATE`,
    [ctx.environment, ctx.partnerUnitId, tokenId]);
    if (!member.rows[0]) throw new Error('collaborator_not_found');
    await client.query(`INSERT INTO network.partner_token_commission_history
      (environment,partner_unit_id,token_id,kind,value,active,starts_on,updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8)
      ON CONFLICT (token_id,starts_on) DO UPDATE SET kind=EXCLUDED.kind,value=EXCLUDED.value,
        active=EXCLUDED.active,updated_by=EXCLUDED.updated_by,updated_at=now()`,
    [ctx.environment, ctx.partnerUnitId, tokenId, input.kind, input.value, input.active, input.starts_on, `owner:${ctx.slug}`]);
    await client.query(`INSERT INTO network.partner_token_commission
      (token_id,environment,partner_unit_id,kind,value,active,updated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (token_id) DO UPDATE SET
      kind=EXCLUDED.kind,value=EXCLUDED.value,active=EXCLUDED.active,updated_at=now(),updated_by=EXCLUDED.updated_by`,
    [tokenId, ctx.environment, ctx.partnerUnitId, input.kind, input.value, input.active, `owner:${ctx.slug}`]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
  const saved = await getPartnerOperationCommissionRule(ctx, tokenId, db);
  if (!saved) throw new Error('collaborator_not_found'); return saved;
}
