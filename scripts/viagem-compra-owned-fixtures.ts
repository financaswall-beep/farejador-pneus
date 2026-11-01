import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

/** Fontes reais de despesas: nenhum trigger é desligado e nenhuma regra é simulada. */
export async function purchaseGroupOwnedFixtures(pool: Pool) {
  const { createMatrizExpense } = await import('../src/admin/painel/queries-financeiro-despesas-integridade.js');
  const { approveMatrizLostFuelReceipt } = await import('../src/admin/painel/queries-logistica-sem-comprovante.js');
  const { approveMatrizTripReceipt } = await import('../src/admin/painel/queries-logistica-comprovantes-decision.js');
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  const createExpense = (category: string, description: string, amount = 40) => createMatrizExpense({
    environment: 'test', category, description, amount, payment_status: 'pending', due_date: '2026-12-31',
    created_by: 'prova-viagem', idempotency_key: randomUUID(),
  }, pool);
  const fuel = await createExpense('combustivel', 'Combustível legado da rota');
  await pool.query(`INSERT INTO commerce.matriz_delivery_trips(environment,courier_name,fuel_expense_id)
    VALUES ('test','Prova combustível legado',$1)`, [fuel.id]);
  const trip = async (name: string) => (await pool.query(`INSERT INTO commerce.matriz_delivery_trips
    (environment,courier_name,status,fuel_spent,ended_at) VALUES ('test',$1,'closed',40,now()) RETURNING id`, [name])).rows[0].id;
  const lostTrip = await trip('Prova comprovante perdido');
  const lost = await approveMatrizLostFuelReceipt({ environment: 'test', trip_id: lostTrip,
    amount: 40, expected_amount: 40, expense_date: today, payment_status: 'paid', payment_date: today,
    reason: 'Comprovante perdido na prova', confirmed: true, actor_label: 'prova-viagem', idempotency_key: randomUUID(),
  }, pool);
  const receiptTrip = await trip('Prova comprovante aprovado');
  const receipt = (await pool.query(`INSERT INTO commerce.matriz_trip_receipts
    (environment,trip_id,mime,size_bytes,ai_status,workflow_status)
    VALUES ('test',$1,'image/jpeg',11,'skipped','review_required') RETURNING id`, [receiptTrip])).rows[0].id;
  await pool.query(`INSERT INTO commerce.matriz_trip_receipt_blobs(receipt_id,environment,bytes)
    VALUES ($1,'test',convert_to('prova-nota!','UTF8'))`, [receipt]);
  const approved = await approveMatrizTripReceipt({ environment: 'test', receipt_id: receipt,
    amount: 40, category: 'combustivel', document_date: today, competence_month: today.slice(0, 7) + '-01',
    payment_status: 'paid', payment_date: today, possible_duplicate_confirmed: true,
    actor_label: 'prova-viagem', idempotency_key: randomUUID(),
  }, pool);
  const person = (await pool.query(`INSERT INTO network.partner_people(environment,username)
    VALUES ('test',$1) RETURNING id`, ['vc.' + randomUUID()])).rows[0].id;
  const collaborator = (await pool.query(`INSERT INTO network.matriz_collaborators
    (environment,person_id,display_name,job,job_title,work_area)
    VALUES ('test',$1,'Colaborador prova viagem','colaborador','Administrativo','administrative') RETURNING id`, [person])).rows[0].id;
  const period = (await pool.query(`INSERT INTO finance.matriz_payroll_periods(environment,competence)
    VALUES ('test','2026-01-01') ON CONFLICT (environment,competence) DO UPDATE SET competence=EXCLUDED.competence RETURNING id`)).rows[0].id;
  const payrollExpense = await createExpense('funcionario', 'Folha da prova viagem', 100);
  await pool.query(`INSERT INTO finance.matriz_payroll_items(environment,payroll_period_id,collaborator_id,
    job_title,employment_type,base_salary,commission_amount,additions,deductions,total_due,due_date,source_expense_id)
    VALUES ('test',$1,$2,'Administrativo','clt',100,0,0,0,100,'2026-12-31',$3)`, [period, collaborator, payrollExpense.id]);
  const commissionExpense = await createExpense('funcionario', 'Comissão da operação na prova', 100);
  await pool.query(`INSERT INTO finance.matriz_commission_periods(environment,collaborator_id,
    settlement_frequency,period_start,period_end,sales_count,gross_sales,commission_amount,
    earned_amount,deductions,source_expense_id,closed_by)
    VALUES ('test',$1,'weekly','2026-10-25','2026-10-31',1,1000,100,100,0,$2,'prova-viagem')`, [collaborator, commissionExpense.id]);
  return [fuel.id, lost.expense_id, approved.expense_id, payrollExpense.id, commissionExpense.id];
}
