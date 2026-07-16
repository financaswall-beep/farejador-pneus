import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('0133/0135 — colaboradores e conciliação da folha', () => {
  let db: IntegrationDb;
  let getManagement: typeof import('../../src/admin/painel/queries-colaboradores-gestao.js').getMatrizCollaboratorManagement;
  let saveCompensation: typeof import('../../src/admin/painel/queries-colaboradores-folha.js').saveMatrizCollaboratorCompensation;
  let saveCommission: typeof import('../../src/admin/painel/queries-colaboradores-folha.js').saveMatrizCollaboratorCommission;
  let closePayroll: typeof import('../../src/admin/painel/queries-colaboradores-folha.js').closeMatrizPayroll;
  let payPayrollItem: typeof import('../../src/admin/painel/queries-colaboradores-folha.js').payMatrizPayrollItem;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
      CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'emergency-token',
    });
    db = await startPostgres();
    ({ getMatrizCollaboratorManagement: getManagement } = await import('../../src/admin/painel/queries-colaboradores-gestao.js'));
    ({
      saveMatrizCollaboratorCompensation: saveCompensation,
      saveMatrizCollaboratorCommission: saveCommission,
      closeMatrizPayroll: closePayroll,
      payMatrizPayrollItem: payPayrollItem,
    } = await import('../../src/admin/painel/queries-colaboradores-folha.js'));
  }, 120_000);
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
       VALUES ('test','funcionario','Folha 07/2026 - Ana Secretaria',2500,'2026-07-01','pending','2026-08-05')
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

  it('preserva vigencias, usa salario mensal integral e aplica a regra vigente em cada venda', async () => {
    const person = await db.pool.query<{ id: string }>(
      `INSERT INTO network.partner_people (environment,username)
       VALUES ('test','vendedor.historico') RETURNING id`,
    );
    const collaborator = await db.pool.query<{ id: string }>(
      `INSERT INTO network.matriz_collaborators
         (environment,person_id,display_name,job,job_title,work_area)
       VALUES ('test',$1,'Vendedor Historico','vendedor','Vendedor','sales') RETURNING id`,
      [person.rows[0]!.id],
    );
    const collaboratorId = collaborator.rows[0]!.id;
    await saveCompensation({
      collaborator_id: collaboratorId, employment_type: 'clt', base_salary: 3100,
      payment_day: 5, payment_method: 'pix', starts_on: '2026-07-01', environment: 'test',
    }, db.pool);
    await saveCompensation({
      collaborator_id: collaboratorId, employment_type: 'clt', base_salary: 6200,
      payment_day: 5, payment_method: 'pix', starts_on: '2026-07-16', environment: 'test',
    }, db.pool);
    await saveCommission({
      collaborator_id: collaboratorId, kind: 'fixed', basis: 'sale', value: 10,
      starts_on: '2026-07-01', environment: 'test',
    }, db.pool);
    await saveCommission({
      collaborator_id: collaboratorId, kind: 'fixed', basis: 'sale', value: 20,
      starts_on: '2026-07-20', environment: 'test',
    }, db.pool);

    const contact = await db.pool.query<{ id: string }>(
      `INSERT INTO core.contacts (environment,chatwoot_contact_id,name)
       VALUES ('test',91001,'Cliente da comissao') RETURNING id`,
    );
    const unit = await db.pool.query<{ id: string }>(
      `INSERT INTO core.units (environment,slug,name)
       VALUES ('test','main','Matriz de teste') RETURNING id`,
    );
    await db.pool.query(
      `INSERT INTO commerce.orders
         (environment,contact_id,unit_id,total_amount,status,fulfillment_mode,seller_collaborator_id,created_at)
       VALUES ('test',$1,$3,100,'confirmed','pickup',$2,'2026-07-10T15:00:00Z'),
              ('test',$1,$3,200,'confirmed','pickup',$2,'2026-07-25T15:00:00Z'),
              ('test',$1,$3,999,'cancelled','pickup',$2,'2026-07-28T15:00:00Z')`,
      [contact.rows[0]!.id, collaboratorId, unit.rows[0]!.id],
    );

    const overview = await getManagement('2026-07-01', 'test', db.pool);
    const row = overview.collaborators.find((entry) => entry.id === collaboratorId)!;
    expect(row.monthly_base_salary).toBe(6200);
    expect(row.base_salary).toBe(6200);
    expect(row.sales_count).toBe(2);
    expect(row.commission_amount).toBe(30);
    expect(row.total_due).toBe(6230);

    const versions = await db.pool.query(
      `SELECT
         (SELECT count(*)::int FROM network.matriz_collaborator_compensation WHERE collaborator_id=$1) compensation,
         (SELECT count(*)::int FROM network.matriz_collaborator_commission_rules WHERE collaborator_id=$1) commission`,
      [collaboratorId],
    );
    expect(versions.rows[0]).toEqual({ compensation: 2, commission: 2 });

    const closed = await closePayroll({ competence: '2026-08-01', environment: 'test' }, db.pool);
    expect(closed.items).toBe(1);
    const payroll = await db.pool.query(
      `SELECT i.id,i.total_due,i.payment_status,e.amount,e.payment_status expense_status
         FROM finance.matriz_payroll_items i
         JOIN commerce.matriz_expenses e ON e.id=i.source_expense_id
        WHERE i.payroll_period_id=$1`, [closed.period_id],
    );
    expect(payroll.rows[0]).toMatchObject({
      total_due: '6200.00', payment_status: 'pending', amount: '6200.00', expense_status: 'pending',
    });
    await payPayrollItem({ item_id: payroll.rows[0].id, environment: 'test' }, db.pool);
    const paid = await db.pool.query(
      `SELECT i.payment_status,p.status,e.payment_status expense_status
         FROM finance.matriz_payroll_items i
         JOIN finance.matriz_payroll_periods p ON p.id=i.payroll_period_id
         JOIN commerce.matriz_expenses e ON e.id=i.source_expense_id
        WHERE i.id=$1`, [payroll.rows[0].id],
    );
    expect(paid.rows[0]).toEqual({ payment_status: 'paid', status: 'paid', expense_status: 'paid' });
  });

  it('bloqueia contaminacao entre ambientes e total de folha adulterado', async () => {
    const person = await db.pool.query<{ id: string }>(
      `INSERT INTO network.partner_people (environment,username)
       VALUES ('prod','guard.producao') RETURNING id`,
    );
    const collaborator = await db.pool.query<{ id: string }>(
      `INSERT INTO network.matriz_collaborators
         (environment,person_id,display_name,job,job_title,work_area)
       VALUES ('prod',$1,'Guard Producao','colaborador','Auditor','administrative') RETURNING id`,
      [person.rows[0]!.id],
    );
    const prodPeriod = await db.pool.query<{ id: string }>(
      `INSERT INTO finance.matriz_payroll_periods (environment,competence)
       VALUES ('prod','2026-09-01') RETURNING id`,
    );
    await expect(db.pool.query(
      `INSERT INTO finance.matriz_payroll_items
         (environment,payroll_period_id,collaborator_id,job_title,base_salary,
          commission_amount,additions,deductions,total_due)
       VALUES ('prod',$1,$2,'Auditor',100,0,0,0,99)`,
      [prodPeriod.rows[0]!.id, collaborator.rows[0]!.id],
    )).rejects.toThrow(/matriz_payroll_items_total_due_check/);

    const testPeriod = await db.pool.query<{ id: string }>(
      `INSERT INTO finance.matriz_payroll_periods (environment,competence)
       VALUES ('test','2026-09-01') RETURNING id`,
    );
    await expect(db.pool.query(
      `INSERT INTO finance.matriz_payroll_items
         (environment,payroll_period_id,collaborator_id,job_title,base_salary,
          commission_amount,additions,deductions,total_due)
       VALUES ('prod',$1,$2,'Auditor',100,0,0,0,100)`,
      [testPeriod.rows[0]!.id, collaborator.rows[0]!.id],
    )).rejects.toThrow(/env_match violado/);

    const permission = await db.pool.query(
      `SELECT has_table_privilege('farejador_partner_app',
        'finance.matriz_payroll_items','SELECT') AS can_read`,
    );
    expect(permission.rows[0].can_read).toBe(false);
  });

  it('ignora pedidos cancelados nas datas de primeira e ultima compra', async () => {
    const contact = await db.pool.query<{ id: string }>(
      `INSERT INTO core.contacts (environment,chatwoot_contact_id,name)
       VALUES ('test',91002,'Cliente com cancelamentos') RETURNING id`,
    );
    await db.pool.query(
      `INSERT INTO commerce.orders
         (environment,contact_id,total_amount,status,fulfillment_mode,created_at)
       VALUES ('test',$1,10,'cancelled','pickup','2026-01-01T12:00:00Z'),
              ('test',$1,20,'confirmed','pickup','2026-02-01T12:00:00Z'),
              ('test',$1,30,'cancelled','pickup','2026-03-01T12:00:00Z')`,
      [contact.rows[0]!.id],
    );
    const profile = await db.pool.query(
      `SELECT total_orders,total_spent,first_order_at,last_order_at,cancelled_orders
         FROM commerce.customer_profile WHERE environment='test' AND contact_id=$1`,
      [contact.rows[0]!.id],
    );
    expect(profile.rows[0].total_orders).toBe('1');
    expect(profile.rows[0].total_spent).toBe('20.00');
    expect(profile.rows[0].first_order_at.toISOString()).toBe('2026-02-01T12:00:00.000Z');
    expect(profile.rows[0].last_order_at.toISOString()).toBe('2026-02-01T12:00:00.000Z');
    expect(profile.rows[0].cancelled_orders).toBe('2');
  });
});
