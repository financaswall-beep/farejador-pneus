import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('Logística: correção auditada da anotação de combustível', () => {
  let db: IntegrationDb;
  let correct: typeof import('../../src/admin/painel/queries-logistica-conciliacao.js').correctMatrizTripFuelAnnotation;
  let approve: typeof import('../../src/admin/painel/queries-logistica-comprovantes-decision.js').approveMatrizTripReceipt;
  beforeAll(async () => {
    Object.assign(process.env, { NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
      CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'emergency-token' });
    ({ correctMatrizTripFuelAnnotation: correct } = await import('../../src/admin/painel/queries-logistica-conciliacao.js'));
    ({ approveMatrizTripReceipt: approve } = await import('../../src/admin/painel/queries-logistica-comprovantes-decision.js'));
    db = await startPostgres();
  }, 120_000);
  afterAll(async () => { if (db) await stopPostgres(db); });

  async function trip(fuel = 22533, status = 'closed', environment = 'test') {
    const result = await db.pool.query(`INSERT INTO commerce.matriz_delivery_trips
      (environment,courier_name,status,fuel_spent,km_start,km_end,notes,ended_at)
      VALUES ($1,'Entregador teste',$2,$3,10,25,'Diário original',CASE WHEN $2='closed' THEN now() END) RETURNING id`, [environment, status, fuel]);
    return result.rows[0].id as string;
  }
  function input(id: string, key: string, amount = 0, expected = 22533) {
    return { trip_id: id, amount, expected_amount: expected, reason: 'Valor digitado por engano',
      idempotency_key: key, actor_label: 'Dono (wallace)', environment: 'test' as const };
  }
  async function financialCounts() {
    return (await db.pool.query(`SELECT (SELECT count(*) FROM commerce.matriz_expenses) expenses,
      (SELECT count(*) FROM finance.matriz_ledger_transactions) transactions,
      (SELECT count(*) FROM finance.matriz_ledger_entries) entries`)).rows[0];
  }
  it('resolve anotação incorreta sem inventar despesas, caixa ou alterar o diário', async () => {
    const id = await trip();
    const before = await financialCounts();
    expect(await correct(input(id, 'fuel-correction-first'), db.pool)).toMatchObject({ trip_id: id, fuel_spent: 0, financial_status: 'reconciled' });
    expect(await financialCounts()).toEqual(before);
    const row = (await db.pool.query(`SELECT fuel_spent::text,km_start::text,km_end::text,notes,fuel_expense_id
      FROM commerce.matriz_delivery_trips WHERE id=$1`, [id])).rows[0];
    expect(row).toEqual({ fuel_spent: '0.00', km_start: '10.0', km_end: '25.0', notes: 'Diário original', fuel_expense_id: null });
    const audit = (await db.pool.query(`SELECT actor_label,payload_before,payload_after FROM audit.events
      WHERE entity_id=$1 AND event_type='trip_fuel_annotation_corrected'`, [id])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_label: 'Dono (wallace)', payload_before: { fuel_spent: 22533 },
      payload_after: { fuel_spent: 0, reason: 'Valor digitado por engano' } });
  });
  it('repete a mesma decisão sem duplicar auditoria e recusa chave com conteúdo diferente', async () => {
    const id = await trip(); const command = input(id, 'fuel-correction-replay');
    const first = await correct(command, db.pool);
    expect(await correct(command, db.pool)).toEqual(first);
    await expect(correct({ ...command, amount: 10 }, db.pool)).rejects.toThrow('idempotency_conflict');
    expect((await db.pool.query(`SELECT count(*)::int n FROM audit.events WHERE entity_id=$1
      AND event_type='trip_fuel_annotation_corrected'`, [id])).rows[0].n).toBe(1);
  });
  it('revalida o valor após a trava: duas decisões concorrentes não sobrescrevem a primeira', async () => {
    const id = await trip();
    const outcomes = await Promise.allSettled([correct(input(id, 'fuel-race-a', 0), db.pool), correct(input(id, 'fuel-race-b', 10), db.pool)]);
    expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1);
    const failed = outcomes.find(o => o.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason.message).toBe('trip_fuel_annotation_changed');
  });
  it('não limpa pendências de comprovante e protege ambiente, rota aberta e dados inválidos', async () => {
    const id = await trip();
    await db.pool.query(`INSERT INTO commerce.matriz_trip_receipts
      (environment,trip_id,mime,size_bytes,ai_status,workflow_status)
      VALUES ('test',$1,'image/jpeg',11,'skipped','review_required')`, [id]);
    expect(await correct(input(id, 'fuel-pending-receipt'), db.pool)).toMatchObject({ financial_status: 'pending' });
    await expect(correct(input(await trip(22533, 'open'), 'fuel-open-route'), db.pool)).rejects.toThrow('trip_not_found');
    await expect(correct(input(await trip(22533, 'closed', 'prod'), 'fuel-other-environment'), db.pool)).rejects.toThrow('trip_not_found');
    await expect(correct({ ...input(id, 'fuel-empty-reason'), reason: ' ' }, db.pool)).rejects.toThrow('trip_fuel_correction_invalid');
    await expect(correct(input(id, 'fuel-fraction-amount', 1.001, 0), db.pool)).rejects.toThrow('trip_fuel_correction_invalid');
  });
  it('preserva a despesa aprovada e concilia somente quando a anotação corresponde ao valor real', async () => {
    const id = await trip();
    const receipt = (await db.pool.query(`INSERT INTO commerce.matriz_trip_receipts
      (environment,trip_id,mime,size_bytes,ai_status,workflow_status)
      VALUES ('test',$1,'image/jpeg',11,'skipped','review_required') RETURNING id`, [id])).rows[0].id;
    await db.pool.query(`INSERT INTO commerce.matriz_trip_receipt_blobs(receipt_id,environment,bytes)
      VALUES ($1,'test',convert_to('fuel-receipt-test','UTF8'))`, [receipt]);
    const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date());
    await approve({ receipt_id: receipt, amount: 40, category: 'combustivel', document_date: day,
      competence_month: day.slice(0, 7) + '-01', payment_status: 'paid', payment_date: day,
      idempotency_key: 'fuel-approval-existing-expense', actor_label: 'Dono', environment: 'test' }, db.pool);
    const before = await financialCounts();
    expect(await correct(input(id, 'fuel-approved-correction', 40), db.pool)).toMatchObject({ financial_status: 'reconciled' });
    expect(await financialCounts()).toEqual(before);
    const active = (await db.pool.query(`SELECT e.amount::text,e.deleted_at FROM commerce.matriz_trip_receipts r
      JOIN commerce.matriz_expenses e ON e.id=r.ai_expense_id AND e.environment=r.environment WHERE r.id=$1`, [receipt])).rows[0];
    expect(active).toEqual({ amount: '40.00', deleted_at: null });
  });
});
