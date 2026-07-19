import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyMigrationFile, startPostgres, stopPostgres, type IntegrationDb,
} from './helpers/postgres.js';

describe('0143 - compatibilidade aditiva sobre fixture preenchida', () => {
  let db: IntegrationDb;
  let itemId: string;
  let adjustmentId: string;

  beforeAll(async () => {
    db = await startPostgres({ throughMigration: '0142_customer_identity_privacy.sql' });
    const person = await db.pool.query<{ id: string }>(
      `INSERT INTO network.partner_people(environment,username)
       VALUES ('test','fixture.0143') RETURNING id`,
    );
    const collaborator = await db.pool.query<{ id: string }>(
      `INSERT INTO network.matriz_collaborators
        (environment,person_id,display_name,job,job_title,work_area)
       VALUES ('test',$1,'Fixture 0143','colaborador','Assistente','administrative')
       RETURNING id`, [person.rows[0]!.id],
    );
    const period = await db.pool.query<{ id: string }>(
      `INSERT INTO finance.matriz_payroll_periods(environment,competence)
       VALUES ('test','2026-05-01') RETURNING id`,
    );
    const expense = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.matriz_expenses
        (environment,category,description,amount,occurred_at,payment_status)
       VALUES ('test','funcionario','Fixture folha',100,'2026-05-01','pending') RETURNING id`,
    );
    const item = await db.pool.query<{ id: string }>(
      `INSERT INTO finance.matriz_payroll_items
        (environment,payroll_period_id,collaborator_id,job_title,base_salary,
         commission_amount,additions,deductions,total_due,source_expense_id)
       VALUES ('test',$1,$2,'Assistente',100,0,0,0,100,$3) RETURNING id`,
      [period.rows[0]!.id, collaborator.rows[0]!.id, expense.rows[0]!.id],
    );
    itemId = item.rows[0]!.id;
    const adjustment = await db.pool.query<{ id: string }>(
      `INSERT INTO finance.matriz_payroll_adjustments
        (environment,collaborator_id,competence,kind,description,amount)
       VALUES ('test',$1,'2026-06-01','addition','Ajuste manual existente',25)
       RETURNING id`, [collaborator.rows[0]!.id],
    );
    adjustmentId = adjustment.rows[0]!.id;
    await applyMigrationFile(db.pool, '0143_matriz_logistics_payroll_consistency.sql');
  }, 120_000);

  afterAll(async () => { if (db) await stopPostgres(db); });

  it('preserva ajuste manual e permite somente liquidacao no snapshot antigo', async () => {
    const adjustment = await db.pool.query(
      `SELECT amount::text,source_type,causal_status,idempotency_key
         FROM finance.matriz_payroll_adjustments WHERE id=$1`, [adjustmentId],
    );
    expect(adjustment.rows[0]).toEqual({
      amount: '25.00', source_type: null, causal_status: null, idempotency_key: null,
    });
    await expect(db.pool.query(
      `UPDATE finance.matriz_payroll_items SET total_due=101,base_salary=101 WHERE id=$1`,
      [itemId],
    )).rejects.toThrow('payroll_snapshot_immutable');
    await expect(db.pool.query(
      `UPDATE finance.matriz_payroll_items
          SET payment_status='paid',paid_at=now(),paid_by='fixture' WHERE id=$1`,
      [itemId],
    )).resolves.toMatchObject({ rowCount: 1 });
  });
});
