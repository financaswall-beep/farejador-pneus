import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('0133 — colaboradores e conciliação da folha', () => {
  let db: IntegrationDb;

  beforeAll(async () => { db = await startPostgres(); }, 120_000);
  afterAll(async () => { if (db) await stopPostgres(db); });

  it('aceita cargo livre e sincroniza pagamento feito pelo Financeiro', async () => {
    const person = await db.pool.query<{ id: string }>(
      `INSERT INTO network.partner_people (environment,username)
       VALUES ('test','secretaria.teste') RETURNING id`,
    );
    const collaborator = await db.pool.query<{ id: string }>(
      `INSERT INTO network.matriz_collaborators
         (environment,person_id,display_name,job,job_title,work_area)
       VALUES ('test',$1,'Ana Secretaria','colaborador','Secretária','administrative') RETURNING id`,
      [person.rows[0]!.id],
    );
    const period = await db.pool.query<{ id: string }>(
      `INSERT INTO finance.matriz_payroll_periods (environment,competence)
       VALUES ('test','2026-07-01') RETURNING id`,
    );
    const expense = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.matriz_expenses
         (environment,category,description,amount,occurred_at,payment_status,due_date)
       VALUES ('test','funcionario','Folha 07/2026 · Ana Secretaria',2500,'2026-07-01','pending','2026-08-05')
       RETURNING id`,
    );
    const item = await db.pool.query<{ id: string }>(
      `INSERT INTO finance.matriz_payroll_items
         (environment,payroll_period_id,collaborator_id,job_title,employment_type,
          base_salary,commission_amount,additions,deductions,total_due,due_date,source_expense_id)
       VALUES ('test',$1,$2,'Secretária','clt',2500,0,0,0,2500,'2026-08-05',$3) RETURNING id`,
      [period.rows[0]!.id, collaborator.rows[0]!.id, expense.rows[0]!.id],
    );

    await db.pool.query(
      `UPDATE commerce.matriz_expenses SET payment_status='paid',paid_at=now() WHERE id=$1`,
      [expense.rows[0]!.id],
    );
    const reconciled = await db.pool.query(
      `SELECT i.payment_status item_status,p.status period_status
         FROM finance.matriz_payroll_items i
         JOIN finance.matriz_payroll_periods p ON p.id=i.payroll_period_id
        WHERE i.id=$1`,
      [item.rows[0]!.id],
    );
    expect(reconciled.rows[0]).toMatchObject({ item_status: 'paid', period_status: 'paid' });

    await expect(db.pool.query(
      `UPDATE commerce.matriz_expenses SET deleted_at=now() WHERE id=$1`,
      [expense.rows[0]!.id],
    )).rejects.toThrow('payroll_expense_locked');
  });
});
