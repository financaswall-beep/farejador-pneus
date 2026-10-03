import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('Combustível sem comprovante: aprovação explícita do proprietário', () => {
  let db: IntegrationDb;
  let approve: typeof import('../../src/admin/painel/queries-logistica-sem-comprovante.js').approveMatrizLostFuelReceipt;
  let receipt: typeof import('../../src/admin/painel/queries-logistica-comprovantes-decision.js').approveMatrizTripReceipt;
  let settle: typeof import('../../src/admin/painel/queries-financeiro-integridade.js').settleMatrizExpense;
  let health: typeof import('../../src/admin/painel/matriz-ledger-stage4-reconciliation.js').getMatrizStage4LedgerReconciliation;
  let confirm: typeof import('../../src/admin/painel/queries-logistica-financeiro.js').confirmMatrizTripFuelDivergence;
  let tripSelect: string;
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  beforeAll(async () => {
    Object.assign(process.env, { NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
      CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'test', MATRIZ_CENTRAL_LEDGER: 'true' });
    ({ approveMatrizLostFuelReceipt: approve } = await import('../../src/admin/painel/queries-logistica-sem-comprovante.js'));
    ({ approveMatrizTripReceipt: receipt } = await import('../../src/admin/painel/queries-logistica-comprovantes-decision.js'));
    ({ settleMatrizExpense: settle } = await import('../../src/admin/painel/queries-financeiro-integridade.js'));
    ({ getMatrizStage4LedgerReconciliation: health } = await import('../../src/admin/painel/matriz-ledger-stage4-reconciliation.js'));
    ({ confirmMatrizTripFuelDivergence: confirm } = await import('../../src/admin/painel/queries-logistica-financeiro.js'));
    ({ tripSelect } = await import('../../src/admin/painel/queries-logistica-trip-select.js'));
    db = await startPostgres();
  }, 120_000);
  afterAll(async () => { if (db) await stopPostgres(db); });
  async function trip(fuel = 40, environment = 'test', status = 'closed') {
    return (await db.pool.query(`INSERT INTO commerce.matriz_delivery_trips
      (environment,courier_name,status,fuel_spent,ended_at)
      VALUES ($1,'Entregador',$2,$3,CASE WHEN $2='closed' THEN now() END) RETURNING id`, [environment, status, fuel])).rows[0].id as string;
  }
  function input(id: string, key: string) {
    return { trip_id: id, amount: 40, expense_date: today, payment_status: 'paid' as const,
      payment_date: today, expected_amount: 40, reason: 'Entregador perdeu a nota do abastecimento',
      confirmed: true as const, idempotency_key: key, actor_label: 'Proprietário (wallace)', environment: 'test' as const };
  }
  async function counts() {
    return (await db.pool.query(`SELECT (SELECT count(*)::int FROM commerce.matriz_expenses) expenses,
      (SELECT count(*)::int FROM finance.matriz_ledger_transactions) transactions,
      (SELECT count(*)::int FROM finance.matriz_ledger_entries) entries`)).rows[0];
  }
  async function dto(id: string) {
    return (await db.pool.query(tripSelect + ' AND t.id=$2', ['test', id])).rows[0];
  }
  async function upload(id: string, content = id) {
    const rid = (await db.pool.query(`INSERT INTO commerce.matriz_trip_receipts
      (environment,trip_id,mime,size_bytes,ai_status,workflow_status)
      VALUES ('test',$1,'image/jpeg',11,'skipped','review_required') RETURNING id`, [id])).rows[0].id;
    await db.pool.query(`INSERT INTO commerce.matriz_trip_receipt_blobs(receipt_id,environment,bytes)
      VALUES ($1,'test',convert_to($2,'UTF8'))`, [rid, content]);
    return rid as string;
  }
  it('gera despesa e dinheiro uma vez, registra a exceção e concilia sem inventar um arquivo', async () => {
    const id = await trip(); const command = input(id, 'lost-receipt-paid');
    expect((await health('test', db.pool)).pending_operational.fuel_notes_without_approved_receipt).toBe(1);
    const result = await approve(command, db.pool);
    expect(result.financial_status).toBe('reconciled');
    expect(await approve(command, db.pool)).toEqual(result);
    await expect(approve({ ...command, amount: 41 }, db.pool)).rejects.toThrow('idempotency_conflict');
    const row = await dto(id);
    expect(row.despesas_total).toBe('40.00'); expect(row.approved_fuel_amount).toBe('40.00');
    expect(row.despesas[0]).toMatchObject({ source: 'sem_comprovante', approval_reason: command.reason,
      approved_by: command.actor_label, receipt_id: null });
    expect((await db.pool.query('SELECT count(*)::int n FROM commerce.matriz_trip_receipts WHERE trip_id=$1', [id])).rows[0].n).toBe(0);
    const audit = (await db.pool.query(`SELECT actor_label,payload_after FROM audit.events
      WHERE entity_id=$1 AND event_type='lost_fuel_receipt_approved'`, [id])).rows;
    expect(audit).toHaveLength(1); expect(audit[0]).toMatchObject({ actor_label: command.actor_label,
      payload_after: { expense_id: result.expense_id, reason: command.reason } });
    const ledger = (await db.pool.query(`SELECT source_type FROM finance.matriz_ledger_transactions
      WHERE source_id=$1 ORDER BY source_type`, [result.expense_id])).rows.map(r => r.source_type);
    expect(ledger).toEqual(['commerce.matriz_expense.accrual']);
    const cash = (await db.pool.query(`SELECT sum(e.amount)::text amount FROM finance.matriz_ledger_entries e
      JOIN finance.matriz_ledger_transactions t ON t.id=e.transaction_id
      WHERE t.source_id=$1 AND e.account_code='cash' AND e.side='credit'`, [result.expense_id])).rows[0];
    expect(Number(cash.amount)).toBe(40);
    const reconciled = await health('test', db.pool);
    expect(reconciled.total_errors).toBe(0); expect(reconciled.pending_operational.fuel_notes_without_approved_receipt).toBe(0);
  });
  it('separa gasto de pagamento: a pagar não movimenta caixa até a quitação padrão', async () => {
    const id = await trip();
    const result = await approve({ ...input(id, 'lost-receipt-pending'), payment_status: 'pending', payment_date: null, due_date: today }, db.pool);
    const paymentCount = async () => (await db.pool.query(`SELECT count(*)::int n FROM finance.matriz_ledger_transactions
      WHERE source_id=$1 AND source_type='commerce.matriz_expense.payment'`, [result.expense_id])).rows[0].n;
    expect(await paymentCount()).toBe(0);
    await settle(result.expense_id, 'test', db.pool, { idempotency_key: 'lost-receipt-settle', actor_label: 'Dono' });
    expect(await paymentCount()).toBe(1);
  });
  it('dois cliques com chaves diferentes não criam duas despesas', async () => {
    const id = await trip(); const before = await counts();
    const outcomes = await Promise.allSettled([approve(input(id, 'lost-race-a'), db.pool), approve(input(id, 'lost-race-b'), db.pool)]);
    expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((outcomes.find(r => r.status === 'rejected') as PromiseRejectedResult).reason.message).toBe('trip_fuel_already_approved');
    expect((await counts()).expenses - before.expenses).toBe(1);
  });
  it('nota recuperada vincula a despesa aprovada, sem duplicar e sem aceitar dados divergentes', async () => {
    const id = await trip(); const result = await approve(input(id, 'lost-then-found'), db.pool);
    const rid = await upload(id); const before = await counts();
    const command = { receipt_id: rid, amount: 40, category: 'combustivel', document_date: today,
      competence_month: today.slice(0, 7) + '-01', payment_status: 'paid' as const, payment_date: today,
      actor_label: 'Dono', environment: 'test' as const, idempotency_key: 'found-proof-approval' };
    await expect(receipt(command, db.pool)).rejects.toThrow('receipt_legacy_expense_confirmation_required');
    await expect(receipt({ ...command, amount: 41, legacy_expense_confirmed: true }, db.pool)).rejects.toThrow('receipt_legacy_expense_conflict');
    expect(await receipt({ ...command, legacy_expense_confirmed: true }, db.pool)).toMatchObject({ expense_id: result.expense_id, linked_existing: true });
    expect(await counts()).toEqual(before);
    const row = await dto(id); expect(row.despesas_total).toBe('40.00'); expect(row.approved_fuel_amount).toBe('40.00');
    expect(row.despesas).toHaveLength(1); expect(row.despesas[0].approved_by).toBe('Proprietário (wallace)');
  });
  it('aprovar combustível não impede um recibo de pedágio nem oculta pneu sem custo', async () => {
    const id = await trip(); await approve(input(id, 'lost-with-other-costs'), db.pool);
    await db.pool.query(`INSERT INTO commerce.matriz_expense_categories(environment,slug,label)
      VALUES ('test','pedagio','Pedágio') ON CONFLICT DO NOTHING`);
    const rid = await upload(id);
    await receipt({ receipt_id: rid, amount: 12, category: 'pedagio', document_date: today,
      competence_month: today.slice(0, 7) + '-01', payment_status: 'paid', payment_date: today,
      actor_label: 'Dono', environment: 'test', idempotency_key: 'lost-and-toll-receipt' }, db.pool);
    expect((await dto(id)).despesas_total).toBe('52.00'); expect((await dto(id)).approved_fuel_amount).toBe('40.00');
    const unit = (await db.pool.query(`INSERT INTO core.units(environment,slug,name)
      VALUES ('test','lost-fuel-unit','Unidade fictícia') RETURNING id`)).rows[0].id;
    const customer = (await db.pool.query(`INSERT INTO commerce.customers(environment,name)
      VALUES ('test','Cliente fictício') RETURNING id`)).rows[0].id;
    const product = (await db.pool.query(`INSERT INTO commerce.products(environment,product_code,product_name,product_type,brand,tire_condition)
      VALUES ('test','LOST-FUEL','Pneu fictício','tire','Pirelli','novo') RETURNING id`)).rows[0].id;
    const order = (await db.pool.query(`INSERT INTO commerce.orders(environment,customer_id,unit_id,total_amount,status,fulfillment_mode,delivery_address,trip_id,delivery_status,delivered_at)
      VALUES ('test',$1,$2,99,'delivered','delivery','Endereço fictício',$3,'delivered',now()) RETURNING id`, [customer, unit, id])).rows[0].id;
    await db.pool.query(`INSERT INTO commerce.order_items(environment,order_id,product_id,quantity,unit_price)
      VALUES ('test',$1,$2,1,99)`, [order, product]);
    expect((await dto(id)).financial_status).toBe('pending');
  });
  it('preserva divergência e bloqueia comprovante em revisão, rota aberta, outro ambiente e decisão desatualizada', async () => {
    const id = await trip(50);
    expect(await approve({ ...input(id, 'lost-divergence'), expected_amount: 50 }, db.pool)).toMatchObject({ financial_status: 'divergent' });
    expect(await confirm({ trip_id: id, actor_label: 'Dono', environment: 'test' }, db.pool)).toMatchObject({ financial_status: 'reconciled', approved_fuel_amount: 40 });
    const pending = await trip(); await upload(pending);
    await expect(approve(input(pending, 'lost-unreviewed'), db.pool)).rejects.toThrow('trip_receipt_review_required');
    await expect(approve(input(await trip(40, 'test', 'open'), 'lost-open'), db.pool)).rejects.toThrow('trip_not_found');
    await expect(approve(input(await trip(40, 'prod'), 'lost-prod'), db.pool)).rejects.toThrow('trip_not_found');
    await expect(approve({ ...input(await trip(), 'lost-stale'), expected_amount: 50 }, db.pool)).rejects.toThrow('trip_fuel_annotation_changed');
  });
  it('não aprova valor, data, motivo ou confirmação inválidos nem elimina despesa já registrada', async () => {
    const id = await trip(); const before = await counts();
    for (const change of [{ amount: 0 }, { amount: 1.001 }, { amount: 10001 }, { expense_date: '2099-01-01' },
      { expense_date: '2026-02-30' }, { reason: '' }, { confirmed: false }, { actor_label: '' }]) {
      await expect(approve({ ...input(id, 'lost-invalid'), ...change } as any, db.pool)).rejects.toThrow();
    }
    const legacy = await db.pool.query(`INSERT INTO commerce.matriz_expenses(environment,category,amount)
      VALUES ('test','combustivel',40) RETURNING id`);
    // O vínculo legado só pode existir por migração histórica, nunca pelo aplicativo.
    await db.pool.query('ALTER TABLE commerce.matriz_delivery_trips DISABLE TRIGGER protect_matriz_trip_fuel_expense_link_trigger');
    try { await db.pool.query('UPDATE commerce.matriz_delivery_trips SET fuel_expense_id=$2 WHERE id=$1', [id, legacy.rows[0].id]); }
    finally { await db.pool.query('ALTER TABLE commerce.matriz_delivery_trips ENABLE TRIGGER protect_matriz_trip_fuel_expense_link_trigger'); }
    await expect(approve(input(id, 'lost-existing-expense'), db.pool)).rejects.toThrow('trip_fuel_already_approved');
    expect((await counts()).expenses).toBe(before.expenses + 1);
  });
  it('mantém autorização imutável, despesa protegida e tabela inacessível ao parceiro', async () => {
    const id = await trip(); const result = await approve(input(id, 'lost-immutable'), db.pool);
    await expect(db.pool.query('UPDATE commerce.matriz_trip_lost_receipts SET reason=$2 WHERE trip_id=$1', [id, 'Mudou'])).rejects.toThrow('lost_receipt_approval_immutable');
    await expect(db.pool.query('DELETE FROM commerce.matriz_trip_lost_receipts WHERE trip_id=$1', [id])).rejects.toThrow('lost_receipt_approval_immutable');
    await expect(db.pool.query('UPDATE commerce.matriz_expenses SET deleted_at=now() WHERE id=$1', [result.expense_id])).rejects.toThrow('receipt_expense_locked');
    await expect(db.pool.query('UPDATE commerce.matriz_expenses SET amount=41 WHERE id=$1', [result.expense_id])).rejects.toThrow('receipt_expense_locked');
    const client = await db.pool.connect();
    try {
      await client.query('SET ROLE farejador_partner_app');
      await expect(client.query('SELECT * FROM commerce.matriz_trip_lost_receipts')).rejects.toThrow('permission denied');
      await expect(client.query("SELECT * FROM commerce.matriz_trip_approved_expenses($1,'test')", [id])).rejects.toThrow('permission denied');
    } finally { await client.query('RESET ROLE'); client.release(); }
  });
});
