// AUDITORIA 02/10/2026 - F2.2 comissao de funcionario fora de hora.
// Mover para tests/integration/ JUNTO com o conserto do item (ver docs/PLANO_CORRECOES_AUDITORIA_2026-10-02.md).
// Cenarios: venda retroativa apos fechar a folha; cancelamento de venda retroativa; idem no acerto semanal.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('auditoria: comissao do funcionario com fatos fora de hora', () => {
  let db: IntegrationDb;
  beforeAll(async () => {
    Object.assign(process.env, { NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
      CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'emergency-token',
      WHOLESALE_FINANCE: 'true', MATRIZ_EXPENSES: 'true', MATRIZ_CENTRAL_LEDGER: 'true', MATRIZ_CENTRAL_LEDGER_READ: 'true' });
    db = await startPostgres();
    process.env.DATABASE_URL = db.connectionString;
    await db.pool.query(`INSERT INTO core.units (environment, slug, name, is_active)
      VALUES ('test','main','Matriz',true) ON CONFLICT (environment, slug) DO UPDATE SET is_active=true`);
  }, 240_000);
  afterAll(async () => { if (db) await stopPostgres(db); });

  const q = async (sql: string, params: unknown[] = []) => (await db.pool.query(sql, params)).rows;
  let seq = 0;
  async function seller(name: string, frequency: 'monthly' | 'weekly', salary: number | null) {
    seq += 1;
    const payroll = await import('../../src/admin/painel/queries-colaboradores-folha.js');
    const person = (await q(`INSERT INTO network.partner_people (environment,username) VALUES ('test',$1) RETURNING id`, [`vend.${seq}`]))[0].id;
    const id = (await q(`INSERT INTO network.matriz_collaborators (environment,person_id,display_name,job,job_title,work_area,created_at)
      VALUES ('test',$1,$2,'vendedor','Vendedor','sales','2026-08-01T12:00:00Z') RETURNING id`, [person, name]))[0].id as string;
    if (salary !== null) await payroll.saveMatrizCollaboratorCompensation({ collaborator_id: id, employment_type: 'clt', base_salary: salary,
      payment_day: 5, payment_method: 'pix', starts_on: '2026-08-01', environment: 'test', actor_label: 'owner:aud' }, db.pool);
    await payroll.saveMatrizCollaboratorCommission({ collaborator_id: id, kind: 'percent', basis: 'revenue', value: 5,
      starts_on: '2026-08-01', settlement_frequency: frequency, environment: 'test', actor_label: 'owner:aud' }, db.pool);
    return id;
  }
  async function wholesaleSale(sellerId: string, soldAt: string, qty: number) {
    seq += 1;
    const measure = `${150 + seq}/${60 + seq}-${10 + seq}`;
    const product = (await q(`INSERT INTO commerce.products (environment,product_code,product_name,product_type)
      VALUES ('test',$1,$2,'tire') RETURNING id`, [`AUD-FH-${seq}`, `Pneu ${seq}`]))[0].id;
    await q(`INSERT INTO commerce.tire_specs (environment,product_id,tire_size,width_mm,aspect_ratio,rim_diameter)
      VALUES ('test',$1,$2,$3,$4,$5)`, [product, measure, 150 + seq, 60 + seq, 10 + seq]);
    await q(`INSERT INTO commerce.wholesale_stock (environment,measure,quantity_on_hand,unit_cost) VALUES ('test',$1,20,40)`, [measure]);
    const { registerWholesaleSale } = await import('../../src/admin/painel/queries-atacado-vendas.js');
    const sale = await registerWholesaleSale({ environment: 'test', new_customer: { name: `Borracheiro ${seq}` },
      items: [{ measure, quantity: qty, unit_price: 100 }], sold_at: soldAt, payment_status: 'paid',
      created_by: 'owner:aud', seller_collaborator_id: sellerId, idempotency_key: randomUUID() } as never, db.pool);
    return sale.order_id as string;
  }
  async function cancel(orderId: string) {
    const { cancelWholesaleSale } = await import('../../src/admin/painel/queries-atacado-cancelar.js');
    await cancelWholesaleSale({ environment: 'test', order_id: orderId, reason: 'borracheiro devolveu',
      cancelled_by: 'owner:aud', idempotency_key: randomUUID() } as never, db.pool);
  }

  it('MENSAL: venda lancada depois de fechar a folha com data do mes fechado, e cancelamento de venda lancada em outro mes', async () => {
    const id = await seller('Vendedor Mensal', 'monthly', 1000);
    // Venda de 30/09 lancada hoje (02/10), antes de fechar a folha de setembro: entra em setembro.
    const s1 = await wholesaleSale(id, '2026-09-30T18:00:00Z', 3);
    const payroll = await import('../../src/admin/painel/queries-colaboradores-folha.js');
    const closed = await payroll.closeMatrizPayroll({ competence: '2026-09-01', environment: 'test', actor_label: 'owner:aud' }, db.pool);
    const item = (await q(`SELECT commission_amount::text FROM finance.matriz_payroll_items WHERE payroll_period_id=$1 AND collaborator_id=$2`, [closed.period_id, id]))[0];
    // Venda de 29/09 lancada DEPOIS do fechamento: nenhuma folha pega.
    await wholesaleSale(id, '2026-09-29T18:00:00Z', 2);
    const { getMatrizCollaboratorManagement } = await import('../../src/admin/painel/queries-colaboradores-gestao.js');
    const october = (await getMatrizCollaboratorManagement('2026-10-01', 'test', db.pool)).collaborators.find((r: { id: string }) => r.id === id);
    const { getFinanceCommissionMonthDetail } = await import('../../src/admin/caixa/finance-commission-month.js');
    const appPreview = await getFinanceCommissionMonthDetail('2026-10', id, undefined, 0, db.pool);
    expect(appPreview?.sales.map(row => Number(row.commission_amount))).toEqual([10]);
    // Cancela a venda que JA FOI PAGA na folha de setembro.
    await cancel(s1);
    const deductions = await q(`SELECT competence::text,amount::text,description FROM finance.matriz_payroll_adjustments
      WHERE environment='test' AND collaborator_id=$1`, [id]);
    console.log('MENSAL folha setembro comissao:', item?.commission_amount,
      '| venda lancada depois do fechamento -> comissao em outubro:', october?.commission_amount,
      '| estorno apos cancelar venda paga em setembro:', JSON.stringify(deductions));
    expect.soft(item?.commission_amount).toBe('15.00');
    expect.soft(Number(october?.commission_amount ?? 0)).toBe(10);
    expect.soft(deductions.length).toBe(1);
    expect(deductions[0]?.amount).toBe('15.00');
    const frozen = (await q(`SELECT amount::text FROM finance.matriz_commission_facts
      WHERE environment='test' AND source_id=$1`, [s1]))[0];
    expect(frozen.amount).toBe('15.00');
    await expect(q(`UPDATE finance.matriz_commission_facts SET amount=999 WHERE source_id=$1`, [s1]))
      .rejects.toThrow('commission_fact_immutable');
    await expect(q(`DELETE FROM finance.matriz_commission_facts WHERE source_id=$1`, [s1]))
      .rejects.toThrow('commission_fact_immutable');
    await expect(q(`INSERT INTO finance.matriz_commission_facts
      (environment,collaborator_id,source_type,source_id,occurred_at,amount,payroll_item_id,calculation)
      SELECT 'prod',collaborator_id,source_type,source_id,occurred_at,amount,payroll_item_id,calculation
      FROM finance.matriz_commission_facts WHERE source_id=$1`, [s1]))
      .rejects.toThrow('commission_fact_target_mismatch');
    const again = await payroll.closeMatrizPayroll({ competence: '2026-09-01', environment: 'test' }, db.pool);
    expect(again.period_id).toBe(closed.period_id);
  });

  it('SEMANAL: venda retroativa numa semana ja acertada, e cancelamento depois do acerto pago', async () => {
    const id = await seller('Vendedor Semanal', 'weekly', null);
    const s1 = await wholesaleSale(id, '2026-09-15T15:00:00Z', 3);
    const { closeMatrizWeeklyCommissions, payMatrizOperationCommission } = await import('../../src/admin/caixa/operation-commissions.js');
    const rollover = async () => {
      const c = await db.pool.connect();
      try { await c.query('BEGIN'); const r = await closeMatrizWeeklyCommissions(c, new Date('2026-10-02T15:00:00Z')); await c.query('COMMIT'); return r; }
      catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    };
    await rollover();
    const period = (await q(`SELECT id,commission_amount::text FROM finance.matriz_commission_periods WHERE environment='test' AND collaborator_id=$1`, [id]))[0];
    await payMatrizOperationCommission(id, period.id, randomUUID(), 'owner:aud', db.pool);
    // Venda da mesma semana lancada depois do acerto.
    await wholesaleSale(id, '2026-09-16T15:00:00Z', 2);
    const second = await rollover();
    const periods = await q(`SELECT period_start::text,commission_amount::text,
        (SELECT payment_status FROM commerce.matriz_expenses e WHERE e.id=p.source_expense_id) pago
      FROM finance.matriz_commission_periods p WHERE environment='test' AND collaborator_id=$1`, [id]);
    // O borracheiro devolve a venda que ja foi paga na comissao semanal.
    await cancel(s1);
    const deductions = await q(`SELECT amount::text FROM finance.matriz_payroll_adjustments WHERE environment='test' AND collaborator_id=$1`, [id]);
    console.log('SEMANAL acertos:', JSON.stringify(periods), '| segundo fechamento criou:', second.periods_created,
      '| estorno apos cancelar venda ja paga:', JSON.stringify(deductions));
    expect.soft(periods.reduce((s: number, r: { commission_amount: string }) => s + Number(r.commission_amount), 0)).toBe(25);
    expect.soft(deductions.length).toBe(1);
    expect(deductions[0]?.amount).toBe('15.00');
    expect((await rollover()).periods_created).toBe(0);
    await wholesaleSale(id, '2026-09-17T15:00:00Z', 1);
    const c = await db.pool.connect();
    try {
      await c.query('BEGIN');
      await closeMatrizWeeklyCommissions(c, new Date(Math.max(Date.now(), Date.parse('2026-10-16T15:00:00Z'))));
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    const zero = (await q(`SELECT earned_amount::text,deductions::text,commission_amount::text,
      source_expense_id,payment_status FROM finance.matriz_commission_periods
      WHERE environment='test' AND collaborator_id=$1 ORDER BY period_start DESC LIMIT 1`, [id]))[0];
    expect(zero).toMatchObject({earned_amount:'5.00',deductions:'5.00',commission_amount:'0.00',
      source_expense_id:null,payment_status:'paid'});
    const balance = (await q(`SELECT a.amount-COALESCE(sum(al.amount),0) remaining
      FROM finance.matriz_payroll_adjustments a LEFT JOIN finance.matriz_payroll_adjustment_allocations al
      ON al.environment=a.environment AND al.adjustment_id=a.id WHERE a.collaborator_id=$1
      GROUP BY a.id`, [id]))[0];
    expect(Number(balance.remaining)).toBe(10);
    const { getFinanceCommissionMonthDetail } = await import('../../src/admin/caixa/finance-commission-month.js');
    const detail = await getFinanceCommissionMonthDetail('2026-09', id, period.id, 0, db.pool);
    expect(detail?.sales).toHaveLength(1);
    expect(detail?.sales[0]?.commission_amount).toBe('15.00');
  });
});
