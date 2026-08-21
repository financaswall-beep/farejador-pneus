#!/usr/bin/env node

'use strict';

const { Client } = require('pg');

if (process.env.FAREJADOR_ENV !== 'prod') throw new Error('prod_environment_required');
if (!process.env.DATABASE_URL) throw new Error('database_url_required');

const checks = {
  matriz_period_overlaps: `SELECT count(*)::int value
    FROM network.matriz_collaborator_employment_periods a
    JOIN network.matriz_collaborator_employment_periods b
      ON b.environment=a.environment AND b.collaborator_id=a.collaborator_id AND b.id>a.id
     AND tstzrange(a.started_at,COALESCE(a.ended_at,'infinity'),'[]')
       && tstzrange(b.started_at,COALESCE(b.ended_at,'infinity'),'[]')`,
  partner_period_overlaps: `SELECT count(*)::int value
    FROM network.partner_collaborator_employment_periods a
    JOIN network.partner_collaborator_employment_periods b
      ON b.environment=a.environment AND b.token_id=a.token_id AND b.id>a.id
     AND tstzrange(a.started_at,COALESCE(a.ended_at,'infinity'),'[]')
       && tstzrange(b.started_at,COALESCE(b.ended_at,'infinity'),'[]')`,
  matriz_open_mismatch: `SELECT count(*)::int value FROM network.matriz_collaborators c
    LEFT JOIN LATERAL (SELECT count(*)::int amount
      FROM network.matriz_collaborator_employment_periods p
      WHERE p.environment=c.environment AND p.collaborator_id=c.id AND p.ended_at IS NULL) open ON true
    WHERE (c.revoked_at IS NULL AND open.amount<>1) OR (c.revoked_at IS NOT NULL AND open.amount<>0)`,
  partner_open_mismatch: `SELECT count(*)::int value FROM network.partner_access_tokens t
    LEFT JOIN LATERAL (SELECT count(*)::int amount
      FROM network.partner_collaborator_employment_periods p
      WHERE p.environment=t.environment AND p.token_id=t.id AND p.ended_at IS NULL) open ON true
    WHERE t.role='funcionario' AND ((t.revoked_at IS NULL AND open.amount<>1)
      OR (t.revoked_at IS NOT NULL AND open.amount<>0))`,
  matriz_period_scope_mismatch: `SELECT count(*)::int value
    FROM network.matriz_collaborator_employment_periods p
    LEFT JOIN network.matriz_collaborators c ON c.id=p.collaborator_id AND c.environment=p.environment
    WHERE c.id IS NULL`,
  partner_period_scope_mismatch: `SELECT count(*)::int value
    FROM network.partner_collaborator_employment_periods p
    LEFT JOIN network.partner_access_tokens t ON t.id=p.token_id
      AND t.environment=p.environment AND t.partner_unit_id=p.partner_unit_id
    WHERE t.id IS NULL`,
  staff_without_permissions: `SELECT count(*)::int value FROM network.partner_access_tokens t
    WHERE t.role='funcionario' AND NOT EXISTS(
      SELECT 1 FROM network.partner_token_permissions p WHERE p.token_id=t.id
        AND p.environment=t.environment AND p.partner_unit_id=t.partner_unit_id)`,
  invalid_job_roles: `SELECT count(*)::int value FROM network.partner_access_tokens
    WHERE job_role NOT IN ('vendedor','estoque','entregador','colaborador')`,
  current_or_future_matriz_payroll: `SELECT count(*)::int value
    FROM finance.matriz_payroll_periods
    WHERE competence>=date_trunc('month',now() AT TIME ZONE 'America/Sao_Paulo')::date`,
  overallocated_adjustments: `SELECT count(*)::int value FROM (
    SELECT a.id FROM finance.matriz_payroll_adjustments a
    LEFT JOIN finance.matriz_payroll_adjustment_allocations x
      ON x.environment=a.environment AND x.adjustment_id=a.id
    GROUP BY a.id,a.amount HAVING COALESCE(sum(x.amount),0)>a.amount) invalid`,
  allocation_scope_mismatch: `SELECT count(*)::int value
    FROM finance.matriz_payroll_adjustment_allocations x
    JOIN finance.matriz_payroll_adjustments a ON a.id=x.adjustment_id
    JOIN finance.matriz_payroll_items i ON i.id=x.payroll_item_id
    WHERE a.environment<>x.environment OR i.environment<>x.environment
      OR a.collaborator_id<>i.collaborator_id`,
  partner_role_privilege_leaks: `SELECT count(*)::int value FROM (VALUES
    (has_table_privilege('farejador_partner_app','network.matriz_collaborator_employment_periods','SELECT')),
    (has_table_privilege('farejador_partner_app','network.partner_collaborator_employment_periods','SELECT')),
    (has_table_privilege('farejador_partner_app','finance.matriz_payroll_adjustment_allocations','SELECT'))
  ) permission(allowed) WHERE allowed`,
  updated_partner_functions_missing: `SELECT count(*)::int value FROM (VALUES
    ('run_partner_staff_salary_rollover'),('prepare_partner_payroll_period'),
    ('sync_partner_commission_to_payroll'),('run_partner_staff_payroll_seed')
  ) expected(name) WHERE NOT EXISTS(
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='finance' AND p.proname=expected.name
       AND pg_get_functiondef(p.oid) LIKE '%partner_collaborator_employed_in_period%')`,
};

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = {};
    for (const [name, sql] of Object.entries(checks)) {
      result[name] = (await client.query(sql)).rows[0].value;
    }
    const totals = await client.query(`SELECT jsonb_build_object(
      'matriz_periods',(SELECT count(*) FROM network.matriz_collaborator_employment_periods),
      'partner_periods',(SELECT count(*) FROM network.partner_collaborator_employment_periods),
      'allocation_rows',(SELECT count(*) FROM finance.matriz_payroll_adjustment_allocations),
      'permission_rows',(SELECT count(*) FROM network.partner_token_permissions)
    ) totals`);
    await client.query('ROLLBACK');
    const pass = Object.values(result).every((value) => Number(value) === 0);
    console.log(JSON.stringify({ environment: 'prod', read_only: true, pass,
      checks: result, totals: totals.rows[0].totals }, null, 2));
    if (!pass) process.exitCode = 1;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`TEAM_AUDIT_FAILED:${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
