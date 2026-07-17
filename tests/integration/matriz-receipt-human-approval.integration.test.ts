import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyMigrationFile, startPostgres, stopPostgres, type IntegrationDb,
} from './helpers/postgres.js';

describe('Etapa 7 — schema descartavel de comprovantes com aprovacao humana', () => {
  let db: IntegrationDb;
  let tripIds: string[];

  beforeAll(async () => {
    db = await startPostgres({ throughMigration: '0139_partner_commission_causal_ledger.sql' });
    process.env.DATABASE_URL = db.connectionString;
    process.env.FAREJADOR_ENV = 'test';
    process.env.NODE_ENV = 'test';
    process.env.CHATWOOT_HMAC_SECRET = 'receipt-test-secret';
    process.env.ADMIN_AUTH_TOKEN = 'receipt-admin-test-token';
    process.env.MATRIZ_RECEIPT_APPROVAL_MAX_AMOUNT = '10000';
    const trips = await db.pool.query<{ id: string }>(`
      INSERT INTO commerce.matriz_delivery_trips(environment,courier_name)
      VALUES ('test','Legado Etapa 7 A'),('test','Legado Etapa 7 B'),
             ('test','Legado Etapa 7 com combustível')
      RETURNING id
    `);
    tripIds = trips.rows.map((row) => row.id);
    const expenses = await db.pool.query<{ id: string }>(`
      INSERT INTO commerce.matriz_expenses
        (environment,category,description,amount,payment_status,paid_at,created_by)
      VALUES
        ('test','combustivel','Legado ativo',10.00,'paid',now(),'ia-comprovante'),
        ('test','outros','Legado removido',20.00,'paid',now(),'ia-comprovante'),
        ('test','combustivel','Duplicata A',7.10,'paid',now(),'ia-comprovante'),
        ('test','combustivel','Duplicata B',7.10,'paid',now(),'ia-comprovante')
      RETURNING id
    `);
    await db.pool.query(`UPDATE commerce.matriz_expenses SET deleted_at=now() WHERE id=$1`,
      [expenses.rows[1]!.id]);
    await db.pool.query(`UPDATE commerce.matriz_delivery_trips SET fuel_expense_id=$2 WHERE id=$1`,
      [tripIds[2], expenses.rows[0]!.id]);

    const fixtures = [
      { status: 'parsed', expense: expenses.rows[0]!.id, bytes: 'legado-ativo' },
      { status: 'parsed', expense: expenses.rows[1]!.id, bytes: 'legado-removido' },
      { status: 'unreadable', expense: null, bytes: 'legado-ilegivel' },
      { status: 'skipped', expense: null, bytes: 'legado-pulado' },
      { status: 'pending', expense: null, bytes: 'legado-pendente' },
      { status: 'parsed', expense: expenses.rows[2]!.id, bytes: 'legado-duplicado' },
      { status: 'parsed', expense: expenses.rows[3]!.id, bytes: 'legado-duplicado' },
    ];
    for (const [index, fixture] of fixtures.entries()) {
      const bytes = Buffer.from(fixture.bytes);
      const receipt = await db.pool.query<{ id: string }>(`
        INSERT INTO commerce.matriz_trip_receipts
          (environment,trip_id,mime,size_bytes,ai_status,ai_expense_id,ai_summary)
        VALUES ('test',$1,'image/jpeg',$2,$3,$4,$5)
        RETURNING id
      `, [tripIds[index % 2], bytes.length, fixture.status, fixture.expense,
        `fixture-${index + 1}`]);
      await db.pool.query(`
        INSERT INTO commerce.matriz_trip_receipt_blobs(receipt_id,environment,bytes)
        VALUES ($1,'test',$2)
      `, [receipt.rows[0]!.id, bytes]);
    }
    await applyMigrationFile(db.pool, '0140_matriz_receipt_human_approval.sql');
  }, 180_000);

  afterAll(async () => {
    if (db) await stopPostgres(db);
  });

  it('aplica 0001–0140 e instala o workflow sem inventar aprovador no legado', async () => {
    const schema = await db.pool.query<{
      receipt_columns: string[];
      expense_columns: string[];
      attempts: string | null;
      decisions: string | null;
    }>(`
      SELECT
        ARRAY(SELECT column_name::text FROM information_schema.columns
          WHERE table_schema='commerce' AND table_name='matriz_trip_receipts'
          ORDER BY column_name) AS receipt_columns,
        ARRAY(SELECT column_name::text FROM information_schema.columns
          WHERE table_schema='commerce' AND table_name='matriz_expenses'
          ORDER BY column_name) AS expense_columns,
        to_regclass('commerce.matriz_trip_receipt_ai_attempts')::text AS attempts,
        to_regclass('commerce.matriz_trip_receipt_decisions')::text AS decisions
    `);

    expect(schema.rows[0]!.receipt_columns).toContain('workflow_status');
    expect(schema.rows[0]!.expense_columns).toEqual(expect.arrayContaining([
      'document_date', 'competence_month',
    ]));
    expect(schema.rows[0]!.attempts).toBe('commerce.matriz_trip_receipt_ai_attempts');
    expect(schema.rows[0]!.decisions).toBe('commerce.matriz_trip_receipt_decisions');

    const legacy = await db.pool.query<{
      workflow_status: string;
      count: number;
    }>(`
      SELECT workflow_status,count(*)::int AS count
        FROM commerce.matriz_trip_receipts
       WHERE environment='test' AND ai_summary LIKE 'fixture-%'
       GROUP BY workflow_status ORDER BY workflow_status
    `);
    expect(legacy.rows).toEqual([
      { workflow_status: 'legacy_linked', count: 4 },
      { workflow_status: 'review_required', count: 3 },
    ]);
    expect((await db.pool.query(`SELECT count(*)::int AS count
      FROM commerce.matriz_trip_receipt_decisions`)).rows[0].count).toBe(0);
    expect((await db.pool.query(`SELECT count(*)::int AS count
      FROM commerce.matriz_trip_receipt_ai_attempts`)).rows[0].count).toBe(0);
  });

  it('gera hash dos bytes e deixa duplicatas novas sob indice parcial', async () => {
    const columns = await db.pool.query<{
      column_name: string;
      is_generated: string;
      generation_expression: string | null;
    }>(`
      SELECT column_name,is_generated,generation_expression
        FROM information_schema.columns
       WHERE table_schema='commerce'
         AND table_name='matriz_trip_receipt_blobs'
         AND column_name IN ('content_sha256','dedup_enforced')
       ORDER BY column_name
    `);
    const indexes = await db.pool.query<{ indexdef: string }>(`
      SELECT indexdef FROM pg_indexes
       WHERE schemaname='commerce'
         AND tablename='matriz_trip_receipt_blobs'
         AND indexdef ILIKE '%content_sha256%'
    `);

    expect(columns.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ column_name: 'content_sha256', is_generated: 'ALWAYS' }),
      expect.objectContaining({ column_name: 'dedup_enforced' }),
    ]));
    expect(columns.rows.find((row) => row.column_name === 'content_sha256')
      ?.generation_expression).toContain('digest');
    expect(indexes.rows.some((row) => /UNIQUE.+WHERE.+dedup_enforced/i.test(row.indexdef)))
      .toBe(true);

    const duplicateLegacy = await db.pool.query<{ count: number; enforced: boolean[] }>(`
      SELECT count(*)::int AS count,array_agg(dedup_enforced ORDER BY receipt_id) AS enforced
        FROM commerce.matriz_trip_receipt_blobs
       WHERE environment='test'
         AND content_sha256=pg_catalog.sha256(convert_to('legado-duplicado','UTF8'))
    `);
    expect(duplicateLegacy.rows[0]).toEqual({ count: 2, enforced: [false, false] });

    const newReceipt = await db.pool.query<{ id: string }>(`
      INSERT INTO commerce.matriz_trip_receipts
        (environment,trip_id,mime,size_bytes,ai_status,workflow_status)
      VALUES ('test',$1,'image/jpeg',16,'pending','uploaded') RETURNING id
    `, [tripIds[0]]);
    await expect(db.pool.query(`
      INSERT INTO commerce.matriz_trip_receipt_blobs(receipt_id,environment,bytes)
      VALUES ($1,'test',convert_to('legado-duplicado','UTF8'))
    `, [newReceipt.rows[0]!.id])).rejects.toMatchObject({ code: '23505' });
    await db.pool.query(`DELETE FROM commerce.matriz_trip_receipts WHERE id=$1`,
      [newReceipt.rows[0]!.id]);
  });

  it('mantem parceiro sem privilegio nas novas tabelas e na regua de competencia', async () => {
    const permissions = await db.pool.query<{ allowed: boolean }>(`
      WITH objects(name) AS (VALUES
        ('commerce.matriz_trip_receipt_ai_attempts'),
        ('commerce.matriz_trip_receipt_decisions')
      ), privileges(name) AS (VALUES
        ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')
      )
      SELECT has_table_privilege('farejador_partner_app',o.name,p.name) AS allowed
        FROM objects o CROSS JOIN privileges p
      UNION ALL
      SELECT has_function_privilege(
        'farejador_partner_app',
        'ops.matriz_expense_competence_month(date,timestamp with time zone)',
        'EXECUTE'
      ) AS allowed
    `);

    expect(permissions.rows.every((row) => row.allowed === false)).toBe(true);
  });

  it('distingue despesa legada ativa de removida sem recriar dinheiro', async () => {
    const linked = await db.pool.query<{
      description: string;
      deleted: boolean;
      workflow_status: string;
    }>(`
      SELECT e.description,e.deleted_at IS NOT NULL AS deleted,r.workflow_status
        FROM commerce.matriz_trip_receipts r
        JOIN commerce.matriz_expenses e ON e.id=r.ai_expense_id
       WHERE r.environment='test' AND e.description LIKE 'Legado %'
       ORDER BY e.description
    `);
    expect(linked.rows).toEqual([
      { description: 'Legado ativo', deleted: false, workflow_status: 'legacy_linked' },
      { description: 'Legado removido', deleted: true, workflow_status: 'legacy_linked' },
    ]);
  });

  it('bloqueia ambiente cruzado nas chaves novas', async () => {
    const receipt = await db.pool.query<{ id: string }>(`
      INSERT INTO commerce.matriz_trip_receipts
        (environment,trip_id,mime,size_bytes,ai_status,workflow_status)
      VALUES ('test',$1,'image/jpeg',8,'pending','uploaded') RETURNING id
    `, [tripIds[0]]);
    await expect(db.pool.query(`
      INSERT INTO commerce.matriz_trip_receipt_blobs(receipt_id,environment,bytes)
      VALUES ($1,'prod',convert_to('cruzado','UTF8'))
    `, [receipt.rows[0]!.id])).rejects.toMatchObject({ code: '23503' });
    await db.pool.query(`DELETE FROM commerce.matriz_trip_receipts WHERE id=$1`,
      [receipt.rows[0]!.id]);
  });

  it('mantem fallback legado da competencia e fecha as portas antigas no banco', async () => {
    const competence = await db.pool.query<{ month: string }>(`
      SELECT ops.matriz_expense_competence_month(
        NULL,'2026-07-31 23:30:00-03'::timestamptz)::text AS month
    `);
    expect(competence.rows[0]!.month).toBe('2026-07-01');

    const receipt = await db.pool.query<{ id: string }>(`
      INSERT INTO commerce.matriz_trip_receipts
        (environment,trip_id,mime,size_bytes,ai_status,workflow_status)
      VALUES ('test',$1,'image/jpeg',10,'pending','review_required') RETURNING id
    `, [tripIds[0]]);
    await db.pool.query(`INSERT INTO commerce.matriz_trip_receipt_blobs
      (receipt_id,environment,bytes) VALUES ($1,'test',convert_to('porta-antiga','UTF8'))`,
    [receipt.rows[0]!.id]);
    const expense = await db.pool.query<{ id: string }>(`
      INSERT INTO commerce.matriz_expenses(environment,category,description,amount,payment_status,paid_at)
      VALUES ('test','combustivel','porta antiga',1,'paid',now()) RETURNING id
    `);
    await expect(db.pool.query(`UPDATE commerce.matriz_trip_receipts
      SET workflow_status='linked',ai_expense_id=$2 WHERE id=$1`,
    [receipt.rows[0]!.id, expense.rows[0]!.id])).rejects.toMatchObject({ code: '23514' });
    await expect(db.pool.query(`UPDATE commerce.matriz_delivery_trips
      SET fuel_expense_id=$2 WHERE id=$1`,
    [tripIds[0], expense.rows[0]!.id])).rejects.toMatchObject({ code: '23514' });
  });

  it('persiste tentativa da IA sem criar despesa e aprova uma unica vez', async () => {
    const q = await import('../../src/admin/painel/queries.js');
    const before = Number((await db.pool.query(`SELECT count(*)::int AS n
      FROM commerce.matriz_expenses WHERE environment='test'`)).rows[0].n);
    const receipt = await db.pool.query<{ id: string }>(`
      INSERT INTO commerce.matriz_trip_receipts
        (environment,trip_id,mime,size_bytes,ai_status,workflow_status)
      VALUES ('test',$1,'image/jpeg',11,'pending','uploaded') RETURNING id
    `, [tripIds[0]]);
    await db.pool.query(`INSERT INTO commerce.matriz_trip_receipt_blobs
      (receipt_id,environment,bytes) VALUES ($1,'test',convert_to('aprovar-uma','UTF8'))`,
    [receipt.rows[0]!.id]);
    const attempt = await q.beginReceiptAiAttempt({ receipt_id: receipt.rows[0]!.id,
      environment: 'test', model: 'modelo-teste', extractor_version: 'v2',
      prompt_version: 'p1' }, db.pool);
    await q.completeReceiptAiAttempt({ attempt_id: attempt.attempt_id, environment: 'test',
      result: { status: 'suggested', amount: 55.25, category: 'combustivel',
        merchant: 'Posto Teste', document_date: '2026-07-16', confidence: 0.91,
        summary: 'Posto Teste · R$ 55,25' } }, db.pool);
    expect(Number((await db.pool.query(`SELECT count(*)::int AS n
      FROM commerce.matriz_expenses WHERE environment='test'`)).rows[0].n)).toBe(before);

    const input = { receipt_id: receipt.rows[0]!.id, ai_attempt_id: attempt.attempt_id,
      amount: 55.25, suggested_amount: 55.25, category: 'combustivel',
      merchant: 'Posto Teste', document_date: '2026-07-16',
      competence_month: '2026-07-01', payment_status: 'paid' as const,
      payment_date: '2026-07-17', retroactive_confirmed: true,
      possible_duplicate_confirmed: true, idempotency_key: 'receipt-approve-once',
      actor_label: 'Administrador Teste', environment: 'test' as const };
    const approved = await q.approveMatrizTripReceipt(input, db.pool);
    const replay = await q.approveMatrizTripReceipt(input, db.pool);
    expect(replay).toEqual(approved);
    const facts = await db.pool.query<{
      workflow_status: string; decisions: number; expenses: number;
      document_date: string; competence_month: string; paid_day: string;
    }>(`
      SELECT r.workflow_status,
        (SELECT count(*)::int FROM commerce.matriz_trip_receipt_decisions d
          WHERE d.receipt_id=r.id) AS decisions,
        (SELECT count(*)::int FROM commerce.matriz_expenses e
          WHERE e.id=r.ai_expense_id) AS expenses,
        e.document_date::text,e.competence_month::text,
        (e.paid_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS paid_day
      FROM commerce.matriz_trip_receipts r
      JOIN commerce.matriz_expenses e ON e.id=r.ai_expense_id
      WHERE r.id=$1
    `, [receipt.rows[0]!.id]);
    expect(facts.rows[0]).toEqual({ workflow_status: 'linked', decisions: 1,
      expenses: 1, document_date: '2026-07-16', competence_month: '2026-07-01',
      paid_day: '2026-07-17' });
  });

  it('deduplica upload concorrente e compartimenta a rota alheia', async () => {
    const q = await import('../../src/admin/painel/queries.js');
    const bytes = Buffer.from('upload-concorrente-etapa-7');
    const [first, replay] = await Promise.all([
      q.addMatrizTripReceipt({ trip_id: tripIds[0]!, bytes,
        mime: 'image/jpeg', environment: 'test' }, db.pool),
      q.addMatrizTripReceipt({ trip_id: tripIds[0]!, bytes,
        mime: 'image/jpeg', environment: 'test' }, db.pool),
    ]);
    expect(first.receipt_id).toBe(replay.receipt_id);
    expect([first.duplicate, replay.duplicate].sort()).toEqual([false, true]);
    const count = await db.pool.query<{ n: number }>(`
      SELECT count(*)::int AS n FROM commerce.matriz_trip_receipt_blobs
       WHERE environment='test' AND content_sha256=pg_catalog.sha256($1::bytea)
    `, [bytes]);
    expect(count.rows[0]!.n).toBe(1);
    await expect(q.addMatrizTripReceipt({ trip_id: tripIds[1]!, bytes,
      mime: 'image/jpeg', environment: 'test' }, db.pool)).rejects.toMatchObject({
        message: 'receipt_exact_duplicate',
        duplicateTripNumber: expect.stringMatching(/^ROTA-/),
      });
    const audit = await db.pool.query<{ payload_after: Record<string, string> }>(`
      SELECT payload_after FROM audit.events
       WHERE environment='test' AND domain='receipt'
         AND event_type='duplicate_upload_blocked'
       ORDER BY created_at DESC LIMIT 1
    `);
    expect(audit.rows[0]!.payload_after).toMatchObject({
      attempted_trip_id: tripIds[1], existing_trip_id: tripIds[0],
      existing_trip_number: expect.stringMatching(/^ROTA-/),
    });
  });

  it('serializa duas aprovacoes diferentes em uma decisao e uma despesa', async () => {
    const q = await import('../../src/admin/painel/queries.js');
    const receipt = await db.pool.query<{ id: string }>(`
      INSERT INTO commerce.matriz_trip_receipts
        (environment,trip_id,mime,size_bytes,ai_status,workflow_status)
      VALUES ('test',$1,'image/jpeg',13,'skipped','review_required') RETURNING id
    `, [tripIds[1]]);
    await db.pool.query(`INSERT INTO commerce.matriz_trip_receipt_blobs
      (receipt_id,environment,bytes) VALUES ($1,'test',convert_to('corrida-aprovar','UTF8'))`,
    [receipt.rows[0]!.id]);
    const base = { receipt_id: receipt.rows[0]!.id, amount: 61.37,
      category: 'manutencao', merchant: 'Oficina Concorrente',
      document_date: '2026-07-15', competence_month: '2026-07-01',
      payment_status: 'pending' as const, due_date: '2026-07-30',
      retroactive_confirmed: true, possible_duplicate_confirmed: true,
      actor_label: 'Administrador Teste', environment: 'test' as const };
    const settled = await Promise.allSettled([
      q.approveMatrizTripReceipt({ ...base, idempotency_key: 'approve-race-first' }, db.pool),
      q.approveMatrizTripReceipt({ ...base, idempotency_key: 'approve-race-second' }, db.pool),
    ]);
    expect(settled.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((item) => item.status === 'rejected')).toHaveLength(1);
    const facts = await db.pool.query<{ decisions: number; expenses: number }>(`
      SELECT
        (SELECT count(*)::int FROM commerce.matriz_trip_receipt_decisions WHERE receipt_id=$1) decisions,
        (SELECT count(*)::int FROM commerce.matriz_expenses e JOIN commerce.matriz_trip_receipts r
          ON r.ai_expense_id=e.id WHERE r.id=$1) expenses
    `, [receipt.rows[0]!.id]);
    expect(facts.rows[0]).toEqual({ decisions: 1, expenses: 1 });
  });

  it('liga despesa legada somente com confirmacao e igualdade sem reescrever valor', async () => {
    const q = await import('../../src/admin/painel/queries.js');
    const legacy = await db.pool.query<{ amount: string; document_date: string;
      competence_month: string; payment_date: string; id: string }>(`
      SELECT e.id,e.amount::text,
        (e.occurred_at AT TIME ZONE 'America/Sao_Paulo')::date::text document_date,
        ops.matriz_expense_competence_month(e.competence_month,e.occurred_at)::text competence_month,
        (e.paid_at AT TIME ZONE 'America/Sao_Paulo')::date::text payment_date
       FROM commerce.matriz_delivery_trips t
       JOIN commerce.matriz_expenses e ON e.id=t.fuel_expense_id WHERE t.id=$1
    `, [tripIds[2]]);
    const receipt = await db.pool.query<{ id: string }>(`
      INSERT INTO commerce.matriz_trip_receipts
        (environment,trip_id,mime,size_bytes,ai_status,workflow_status)
      VALUES ('test',$1,'image/jpeg',14,'skipped','review_required') RETURNING id
    `, [tripIds[2]]);
    await db.pool.query(`INSERT INTO commerce.matriz_trip_receipt_blobs
      (receipt_id,environment,bytes) VALUES ($1,'test',convert_to('ligar-legado','UTF8'))`,
    [receipt.rows[0]!.id]);
    const base = { receipt_id: receipt.rows[0]!.id, amount: Number(legacy.rows[0]!.amount),
      category: 'combustivel', merchant: null,
      document_date: legacy.rows[0]!.document_date,
      competence_month: legacy.rows[0]!.competence_month,
      payment_status: 'paid' as const, payment_date: legacy.rows[0]!.payment_date,
      idempotency_key: 'approve-link-legacy', actor_label: 'Administrador Teste',
      environment: 'test' as const };
    await expect(q.approveMatrizTripReceipt(base, db.pool))
      .rejects.toThrow('receipt_legacy_expense_confirmation_required');
    const before = Number((await db.pool.query(`SELECT count(*)::int AS n
      FROM commerce.matriz_expenses WHERE environment='test'`)).rows[0].n);
    const linked = await q.approveMatrizTripReceipt({ ...base,
      legacy_expense_confirmed: true }, db.pool);
    expect(linked).toMatchObject({ expense_id: legacy.rows[0]!.id, linked_existing: true });
    expect(Number((await db.pool.query(`SELECT count(*)::int AS n
      FROM commerce.matriz_expenses WHERE environment='test'`)).rows[0].n)).toBe(before);
  });

  it('rejeita sem tocar no Financeiro e fechamento salva gasolina sem lancar', async () => {
    const q = await import('../../src/admin/painel/queries.js');
    const trip = await db.pool.query<{ id: string }>(`
      INSERT INTO commerce.matriz_delivery_trips(environment,courier_name)
      VALUES ('test','Fechamento humano') RETURNING id
    `);
    const receipt = await db.pool.query<{ id: string }>(`
      INSERT INTO commerce.matriz_trip_receipts
        (environment,trip_id,mime,size_bytes,ai_status,workflow_status)
      VALUES ('test',$1,'image/jpeg',12,'skipped','review_required') RETURNING id
    `, [trip.rows[0]!.id]);
    await db.pool.query(`INSERT INTO commerce.matriz_trip_receipt_blobs
      (receipt_id,environment,bytes) VALUES ($1,'test',convert_to('rejeitar-uma','UTF8'))`,
    [receipt.rows[0]!.id]);
    const before = Number((await db.pool.query(`SELECT count(*)::int AS n
      FROM commerce.matriz_expenses WHERE environment='test'`)).rows[0].n);
    await q.rejectMatrizTripReceipt({ receipt_id: receipt.rows[0]!.id,
      reason: 'Documento não corresponde à rota', idempotency_key: 'receipt-reject-once',
      actor_label: 'Administrador Teste', environment: 'test' }, db.pool);
    await q.closeMatrizTrip({ trip_id: trip.rows[0]!.id, fuel_spent: 88.40,
      environment: 'test' }, db.pool);
    const state = await db.pool.query<{ workflow_status: string; fuel_spent: string;
      fuel_expense_id: string | null }>(`
      SELECT r.workflow_status,t.fuel_spent::text,t.fuel_expense_id
       FROM commerce.matriz_trip_receipts r
       JOIN commerce.matriz_delivery_trips t ON t.id=r.trip_id WHERE r.id=$1
    `, [receipt.rows[0]!.id]);
    expect(state.rows[0]).toEqual({ workflow_status: 'rejected',
      fuel_spent: '88.40', fuel_expense_id: null });
    expect(Number((await db.pool.query(`SELECT count(*)::int AS n
      FROM commerce.matriz_expenses WHERE environment='test'`)).rows[0].n)).toBe(before);
  });
});
