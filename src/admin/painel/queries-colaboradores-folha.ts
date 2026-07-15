import type { Pool } from 'pg';
import { pool as defaultPool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { getMatrizCollaboratorManagement } from './queries-colaboradores-gestao.js';

export interface MatrizCompensationInput {
  collaborator_id: string; employment_type: 'clt' | 'mei' | 'autonomo' | 'outro';
  base_salary: number; payment_day: number; payment_method: 'pix' | 'transferencia' | 'dinheiro' | 'outro';
  payment_note?: string | null; starts_on: string; environment?: 'prod' | 'test'; actor_label?: string | null;
}

export async function saveMatrizCollaboratorCompensation(input: MatrizCompensationInput, dbPool: Pool = defaultPool) {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const r = await dbPool.query(
    `INSERT INTO network.matriz_collaborator_compensation
       (collaborator_id, environment, employment_type, base_salary, payment_day, payment_method, payment_note, starts_on, updated_by)
     SELECT mc.id, mc.environment, $3, $4, $5, $6, $7, $8::date, $9
       FROM network.matriz_collaborators mc WHERE mc.id=$2 AND mc.environment=$1 AND mc.revoked_at IS NULL
     ON CONFLICT (collaborator_id) DO UPDATE SET
       employment_type=EXCLUDED.employment_type, base_salary=EXCLUDED.base_salary,
       payment_day=EXCLUDED.payment_day, payment_method=EXCLUDED.payment_method,
       payment_note=EXCLUDED.payment_note, starts_on=EXCLUDED.starts_on,
       updated_by=EXCLUDED.updated_by, updated_at=now()
     RETURNING collaborator_id`,
    [environment, input.collaborator_id, input.employment_type, input.base_salary, input.payment_day,
     input.payment_method, input.payment_note ?? null, input.starts_on, input.actor_label ?? null],
  );
  if (!r.rows[0]) throw new Error('collaborator_not_found');
  return { saved: true, collaborator_id: r.rows[0].collaborator_id };
}

export interface MatrizCommissionInput {
  collaborator_id: string; kind: 'percent' | 'fixed';
  basis: 'margin' | 'revenue' | 'sale' | 'delivery' | 'trip'; value: number;
  starts_on: string; active?: boolean; environment?: 'prod' | 'test'; actor_label?: string | null;
}

export async function saveMatrizCollaboratorCommission(input: MatrizCommissionInput, dbPool: Pool = defaultPool) {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const r = await dbPool.query(
    `INSERT INTO network.matriz_collaborator_commission_rules
       (collaborator_id, environment, kind, basis, value, starts_on, active, updated_by)
     SELECT mc.id, mc.environment, $3, $4, $5, $6::date, $7, $8
       FROM network.matriz_collaborators mc WHERE mc.id=$2 AND mc.environment=$1 AND mc.revoked_at IS NULL
     ON CONFLICT (collaborator_id) DO UPDATE SET kind=EXCLUDED.kind, basis=EXCLUDED.basis,
       value=EXCLUDED.value, starts_on=EXCLUDED.starts_on, active=EXCLUDED.active,
       updated_by=EXCLUDED.updated_by, updated_at=now()
     RETURNING collaborator_id`,
    [environment, input.collaborator_id, input.kind, input.basis, input.value, input.starts_on,
     input.active ?? true, input.actor_label ?? null],
  );
  if (!r.rows[0]) throw new Error('collaborator_not_found');
  return { saved: true, collaborator_id: r.rows[0].collaborator_id };
}

export async function addMatrizPayrollAdjustment(input: {
  collaborator_id: string; competence: string; kind: 'addition' | 'deduction';
  description: string; amount: number; environment?: 'prod' | 'test'; actor_label?: string | null;
}, dbPool: Pool = defaultPool) {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const r = await dbPool.query<{ id: string }>(
    `INSERT INTO finance.matriz_payroll_adjustments
       (environment, collaborator_id, competence, kind, description, amount, created_by)
     SELECT mc.environment, mc.id, $3::date, $4, $5, $6, $7
       FROM network.matriz_collaborators mc
      WHERE mc.environment=$1 AND mc.id=$2 AND mc.revoked_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM finance.matriz_payroll_periods p WHERE p.environment=$1 AND p.competence=$3::date)
     RETURNING id`,
    [environment, input.collaborator_id, input.competence, input.kind, input.description.trim(), input.amount, input.actor_label ?? null],
  );
  if (!r.rows[0]) throw new Error('period_closed_or_collaborator_not_found');
  return { created: true, id: r.rows[0].id };
}

export async function removeMatrizPayrollAdjustment(input: {
  id: string; competence: string; environment?: 'prod' | 'test';
}, dbPool: Pool = defaultPool) {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const r = await dbPool.query<{ id: string }>(
    `UPDATE finance.matriz_payroll_adjustments a SET deleted_at=now()
      WHERE a.id=$2 AND a.environment=$1 AND a.competence=$3::date AND a.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM finance.matriz_payroll_periods p WHERE p.environment=$1 AND p.competence=$3::date)
      RETURNING id`, [environment, input.id, input.competence]);
  if (!r.rows[0]) throw new Error('adjustment_not_found_or_period_closed');
  return { removed: true, id: r.rows[0].id };
}

function payrollDueDate(competence: string, paymentDay: number | null): string {
  const [year, month] = competence.split('-').map(Number);
  return new Date(Date.UTC(year!, month!, Math.min(28, paymentDay ?? 5))).toISOString().slice(0, 10);
}

export async function closeMatrizPayroll(input: {
  competence: string; environment?: 'prod' | 'test'; actor_label?: string | null;
}, dbPool: Pool = defaultPool) {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`matriz-payroll:${environment}:${input.competence}`]);
    const exists = await client.query(`SELECT 1 FROM finance.matriz_payroll_periods WHERE environment=$1 AND competence=$2::date`, [environment, input.competence]);
    if (exists.rows[0]) throw new Error('period_already_closed');
    const overview = await getMatrizCollaboratorManagement(input.competence, environment, client as any);
    const eligible = overview.collaborators.filter((r) => r.active && r.total_due > 0
      && (r.employment_type || r.commission_active || r.additions || r.deductions));
    if (!eligible.length) throw new Error('nothing_to_close');
    const period = await client.query<{ id: string }>(
      `INSERT INTO finance.matriz_payroll_periods (environment, competence, closed_by)
       VALUES ($1,$2::date,$3) RETURNING id`, [environment, input.competence, input.actor_label ?? null]);
    const periodId = period.rows[0]!.id;
    for (const row of eligible) {
      const dueDate = payrollDueDate(input.competence, row.payment_day);
      const calculation = {
        rule: row.commission_kind ? { kind: row.commission_kind, basis: row.commission_basis, value: row.commission_value } : null,
        production: { sales: row.sales_count, revenue: row.revenue, margin: row.margin, deliveries: row.deliveries_count, trips: row.trips_count },
      };
      const item = await client.query<{ id: string }>(
        `INSERT INTO finance.matriz_payroll_items
          (environment,payroll_period_id,collaborator_id,job_title,employment_type,base_salary,
           commission_amount,additions,deductions,total_due,due_date,calculation)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) RETURNING id`,
        [environment, periodId, row.id, row.job_title, row.employment_type, row.base_salary,
         row.commission_amount, row.additions, row.deductions, row.total_due, dueDate, JSON.stringify(calculation)]);
      const label = new Intl.DateTimeFormat('pt-BR', { month: '2-digit', year: 'numeric', timeZone: 'UTC' })
        .format(new Date(`${input.competence}T12:00:00Z`));
      const expense = await client.query<{ id: string }>(
        `INSERT INTO commerce.matriz_expenses
          (environment,category,description,amount,occurred_at,payment_status,due_date,created_by)
         VALUES ($1,'funcionario',$2,$3,$4::date,'pending',$5,$6) RETURNING id`,
        [environment, `Folha ${label} · ${row.display_name}`, row.total_due, input.competence, dueDate, input.actor_label ?? null]);
      await client.query(`UPDATE finance.matriz_payroll_items SET source_expense_id=$2 WHERE id=$1`, [item.rows[0]!.id, expense.rows[0]!.id]);
    }
    await client.query('COMMIT');
    return { closed: true, period_id: periodId, items: eligible.length };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally { client.release(); }
}

export async function payMatrizPayrollItem(input: {
  item_id: string; environment?: 'prod' | 'test'; actor_label?: string | null;
}, dbPool: Pool = defaultPool) {
  const environment = input.environment ?? env.FAREJADOR_ENV;
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const item = await client.query<{ id: string; source_expense_id: string; payroll_period_id: string }>(
      `SELECT id,source_expense_id,payroll_period_id FROM finance.matriz_payroll_items
        WHERE id=$2 AND environment=$1 AND payment_status='pending' FOR UPDATE`, [environment, input.item_id]);
    if (!item.rows[0]) throw new Error('payroll_item_not_found');
    const paid = await client.query(
      `UPDATE commerce.matriz_expenses SET payment_status='paid',paid_at=now()
        WHERE id=$1 AND environment=$2 AND payment_status='pending' AND deleted_at IS NULL RETURNING id`,
      [item.rows[0].source_expense_id, environment]);
    if (!paid.rows[0]) throw new Error('payroll_expense_not_found');
    await client.query(`UPDATE finance.matriz_payroll_items SET payment_status='paid',paid_at=now(),paid_by=$2 WHERE id=$1`, [input.item_id, input.actor_label ?? null]);
    await client.query(
      `UPDATE finance.matriz_payroll_periods SET status=CASE WHEN EXISTS
        (SELECT 1 FROM finance.matriz_payroll_items WHERE payroll_period_id=$1 AND payment_status='pending') THEN 'partial' ELSE 'paid' END
       WHERE id=$1`, [item.rows[0].payroll_period_id]);
    await client.query('COMMIT');
    return { paid: true, item_id: input.item_id };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined); throw err;
  } finally { client.release(); }
}
