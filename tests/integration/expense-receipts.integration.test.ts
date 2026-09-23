import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startPostgres, stopPostgres, buildRestrictedConnectionString, type IntegrationDb } from './helpers/postgres.js';
import { Pool } from 'pg';

describe('Comprovante avulso: isolamento e transação financeira', () => {
  let db: IntegrationDb;
  let receipts: typeof import('../../src/admin/painel/expense-receipts.js');
  let ai: typeof import('../../src/admin/painel/expense-receipt-ai.js');
  let expenses: typeof import('../../src/admin/painel/queries-financeiro-despesas-integridade.js');
  const photo = () => Buffer.from('imagem-fixture-' + randomUUID());
  const input = (id: string) => ({ category: 'outros', amount: 51.5, payment_status: 'paid' as const,
    occurred_at: '2026-01-20T15:00:00Z', paid_at: '2026-01-20T15:00:00Z', document_date: '2026-01-20', competence_month: '2026-01-01',
    receipt_id: id, receipt_confirmed: true, created_by: 'Teste local', environment: 'test' as const, idempotency_key: randomUUID() });
  beforeAll(async () => {
    db = await startPostgres();
    Object.assign(process.env, { DATABASE_URL: db.connectionString, FAREJADOR_ENV: 'test', NODE_ENV: 'test',
      CHATWOOT_HMAC_SECRET: 'receipt-test-secret', ADMIN_AUTH_TOKEN: 'receipt-admin-test-token', MATRIZ_RECEIPT_AI: 'true', MATRIZ_CENTRAL_LEDGER: 'true' });
    receipts = await import('../../src/admin/painel/expense-receipts.js');
    ai = await import('../../src/admin/painel/expense-receipt-ai.js');
    expenses = await import('../../src/admin/painel/queries-financeiro-despesas-integridade.js');
  }, 240_000);
  afterAll(async () => { if (db) await stopPostgres(db); });
  it('reutiliza a mesma imagem concorrente e isola prod/test; imagem ainda sem despesa é privada', async () => {
    const bytes = photo();
    const rows = await Promise.all(Array.from({ length: 4 }, () => receipts.addExpenseReceipt(bytes, 'teste', 'test', db.pool)));
    expect(new Set(rows.map(r => r.receipt.id)).size).toBe(1);
    expect(rows.filter(r => !r.duplicate)).toHaveLength(1);
    const id = rows[0]!.receipt.id;
    expect(await receipts.getExpenseReceiptImage(id, true, 'test', db.pool)).toBeNull();
    expect((await receipts.getExpenseReceiptImage(id, false, 'test', db.pool))?.bytes).toEqual(bytes);
    expect(await receipts.getExpenseReceiptImage(id, false, 'prod', db.pool)).toBeNull();
    expect((await receipts.addExpenseReceipt(bytes, 'teste', 'prod', db.pool)).receipt.id).not.toBe(id);
  });
  it('imagem + lançamento + livro central são atômicos; replay retorna a despesa original', async () => {
    const { receipt } = await receipts.addExpenseReceipt(photo(), 'teste', 'test', db.pool);
    const body = input(receipt.id);
    const created = await expenses.createMatrizExpense(body, db.pool);
    expect(await expenses.createMatrizExpense(body, db.pool)).toEqual(created);
    expect((await receipts.getExpenseReceipt(receipt.id, 'test', db.pool)).expense_id).toBe(created.id);
    expect(await receipts.receiptForExpense(created.id, 'test', db.pool)).toEqual({ id: receipt.id });
    expect(await receipts.getExpenseReceiptImage(receipt.id, true, 'test', db.pool)).not.toBeNull();
    const ledger = await db.pool.query(`SELECT count(*)::int AS n FROM finance.matriz_ledger_transactions WHERE environment='test' AND source_id=$1`, [created.id]);
    expect(ledger.rows[0].n).toBe(1);
    await expect(expenses.createMatrizExpense({ ...body, idempotency_key: randomUUID() }, db.pool)).rejects.toThrow('expense_receipt_already_linked');
    await expect(expenses.createMatrizExpense({ ...body, receipt_id: randomUUID() }, db.pool)).rejects.toThrow('idempotency_conflict');
  });
  it('duas confirmações simultâneas criam uma única despesa', async () => {
    const { receipt } = await receipts.addExpenseReceipt(photo(), 'teste', 'test', db.pool);
    const attempts = await Promise.allSettled([expenses.createMatrizExpense(input(receipt.id), db.pool), expenses.createMatrizExpense(input(receipt.id), db.pool)]);
    expect(attempts.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(r => r.status === 'rejected')).toHaveLength(1);
  });
  it('falha ao vincular a foto desfaz também a despesa e os lançamentos do livro central', async () => {
    const { receipt } = await receipts.addExpenseReceipt(photo(), 'teste', 'test', db.pool);
    const body = input(receipt.id);
    const counts = async () => (await db.pool.query(`SELECT
      (SELECT count(*) FROM commerce.matriz_expenses) AS expenses,
      (SELECT count(*) FROM finance.matriz_ledger_transactions) AS ledger`)).rows[0];
    const before = await counts();
    await db.pool.query(`CREATE FUNCTION commerce.fixture_block_receipt_link() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fixture_link_failure'; END $$;
      CREATE TRIGGER fixture_block_receipt_link BEFORE UPDATE OF expense_id ON commerce.matriz_expense_receipts
      FOR EACH ROW EXECUTE FUNCTION commerce.fixture_block_receipt_link()`);
    try { await expect(expenses.createMatrizExpense(body, db.pool)).rejects.toThrow('fixture_link_failure'); }
    finally { await db.pool.query(`DROP TRIGGER fixture_block_receipt_link ON commerce.matriz_expense_receipts; DROP FUNCTION commerce.fixture_block_receipt_link()`); }
    expect(await counts()).toEqual(before);
    expect((await receipts.getExpenseReceipt(receipt.id, 'test', db.pool)).expense_id).toBeNull();
    await expect(expenses.createMatrizExpense(body, db.pool)).resolves.toHaveProperty('id');
  });
  it('rollback libera o comprovante quando categoria ou ambiente são inválidos; requer confirmação explícita', async () => {
    const { receipt } = await receipts.addExpenseReceipt(photo(), 'teste', 'test', db.pool);
    await expect(expenses.createMatrizExpense({ ...input(receipt.id), category: 'inexistente' }, db.pool)).rejects.toThrow('category_invalid');
    expect((await receipts.getExpenseReceipt(receipt.id, 'test', db.pool)).expense_id).toBeNull();
    await expect(expenses.createMatrizExpense({ ...input(receipt.id), environment: 'prod' }, db.pool)).rejects.toThrow('expense_receipt_not_found');
    await expect(expenses.createMatrizExpense({ ...input(receipt.id), receipt_confirmed: false }, db.pool)).rejects.toThrow('expense_receipt_confirmation_required');
    await expect(expenses.createMatrizExpense({ ...input(receipt.id), payment_status: undefined }, db.pool)).rejects.toThrow('expense_receipt_confirmation_required');
    const row = await expenses.createMatrizExpense({ ...input(receipt.id), payment_status: 'pending', paid_at: undefined, due_date: '2026-10-01' }, db.pool);
    expect(row.payment_status).toBe('pending'); expect(row.paid_at).toBeNull();
    const cash = await db.pool.query(`SELECT cash_on FROM finance.matriz_ledger_transactions WHERE source_id=$1`, [row.id]);
    expect(cash.rows.every(r => r.cash_on === null)).toBe(true);
  });
  it('IA nunca cria dinheiro; leitura concorrente é única, releitura conserva histórico e falha permite preenchimento manual', async () => {
    const { receipt } = await receipts.addExpenseReceipt(photo(), 'teste', 'test', db.pool);
    let finish!: () => void;
    const wait = new Promise<void>(resolve => { finish = resolve; });
    const reader = vi.fn(async () => { await wait; return { kind: 'parsed' as const, amount: 51.5, category: 'outros', merchant: 'Loja',
      document_date: '2026-01-20', confidence: 0.9, summary: 'Sugestão', model: 'fixture', extractor_version: 'fixture-v1', prompt_version: 'fixture-v1' }; });
    const first = ai.readExpenseReceipt(receipt.id, false, 'test', db.pool, reader);
    await vi.waitFor(() => expect(reader).toHaveBeenCalledOnce());
    const second = await ai.readExpenseReceipt(receipt.id, false, 'test', db.pool, reader);
    expect(second.processing).toBe(true); expect(reader).toHaveBeenCalledOnce();
    await expect(expenses.createMatrizExpense(input(receipt.id), db.pool)).rejects.toThrow('expense_receipt_processing');
    finish(); const done = await first;
    expect(done.expense_id).toBeNull(); expect(done.status).toBe('parsed');
    await ai.readExpenseReceipt(receipt.id, false, 'test', db.pool, reader); expect(reader).toHaveBeenCalledOnce();
    const failed = await ai.readExpenseReceipt(receipt.id, true, 'test', db.pool, async () => { throw Error('network'); });
    expect(failed.status).toBe('failed'); expect(failed.processing).toBe(false);
    const history = await db.pool.query(`SELECT id,previous_reading_id,source,truth_type,extractor_version,confidence_level FROM analytics.expense_receipt_readings WHERE receipt_id=$1 ORDER BY created_at`, [receipt.id]);
    expect(history.rows).toHaveLength(2); expect(history.rows[1].previous_reading_id).toBe(history.rows[0].id);
    const audit = await db.pool.query(`SELECT superseded_by FROM analytics.expense_receipt_reading_history WHERE id=$1`, [history.rows[0].id]);
    expect(audit.rows[0].superseded_by).toBe(history.rows[1].id);
    expect(history.rows[0]).toMatchObject({ source: 'openai_vision', truth_type: 'suggestion', confidence_level: 'high' });
    await expect(db.pool.query(`UPDATE analytics.expense_receipt_readings SET summary='alterado' WHERE receipt_id=$1`, [receipt.id])).rejects.toThrow('immutable');
    await expect(db.pool.query(`DELETE FROM commerce.matriz_expense_receipt_blobs WHERE receipt_id=$1`, [receipt.id])).rejects.toThrow('immutable');
    await expect(expenses.createMatrizExpense(input(receipt.id), db.pool)).resolves.toHaveProperty('id');
  });
  it('impede reutilizar foto entre Logística e despesa avulsa nos dois sentidos', async () => {
    const trip = (await db.pool.query(`INSERT INTO commerce.matriz_delivery_trips(environment,courier_name) VALUES ('test','Teste') RETURNING id`)).rows[0].id;
    const insertTrip = async (bytes: Buffer) => {
      const r = await db.pool.query(`INSERT INTO commerce.matriz_trip_receipts(environment,trip_id,mime,size_bytes) VALUES ('test',$1,'image/jpeg',$2) RETURNING id`, [trip, bytes.length]);
      return db.pool.query(`INSERT INTO commerce.matriz_trip_receipt_blobs(environment,receipt_id,bytes) VALUES ('test',$1,$2)`, [r.rows[0].id, bytes]);
    };
    const bytes = photo(); await receipts.addExpenseReceipt(bytes, 'teste', 'test', db.pool);
    await expect(insertTrip(bytes)).rejects.toThrow('receipt_belongs_to_expense');
    const other = photo(); await insertTrip(other);
    await expect(receipts.addExpenseReceipt(other, 'teste', 'test', db.pool)).rejects.toThrow('receipt_belongs_to_trip');
  });
  it('a role de parceiro não lê documentos nem sugestões', async () => {
    const restricted = new Pool({ connectionString: buildRestrictedConnectionString(db.connectionString) });
    try {
      for (const table of ['commerce.matriz_expense_receipts', 'commerce.matriz_expense_receipt_blobs', 'analytics.expense_receipt_readings']) {
        await expect(restricted.query('SELECT * FROM ' + table)).rejects.toThrow(/permission denied/);
      }
    } finally { await restricted.end(); }
  });
  it('deduplicação entre fluxos também funciona na corrida; upload normal da Logística é preservado', async () => {
    const { addMatrizTripReceipt } = await import('../../src/admin/painel/queries-logistica-comprovantes.js');
    const trip = (await db.pool.query(`INSERT INTO commerce.matriz_delivery_trips(environment,courier_name) VALUES ('test','Concorrência') RETURNING id`)).rows[0].id;
    const bytes = photo();
    const results = await Promise.allSettled([
      receipts.addExpenseReceipt(bytes, 'teste', 'test', db.pool),
      addMatrizTripReceipt({ environment: 'test', trip_id: trip, bytes, mime: 'image/jpeg' }, db.pool),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    const normal = { environment: 'test' as const, trip_id: trip, bytes: photo(), mime: 'image/jpeg' };
    const created = await addMatrizTripReceipt(normal, db.pool);
    expect(created.duplicate).toBe(false);
    expect(await addMatrizTripReceipt(normal, db.pool)).toMatchObject({ receipt_id: created.receipt_id, duplicate: true });
  });
});
