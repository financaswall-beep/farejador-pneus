import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

type LedgerLine = {
  account_code: string;
  account_class: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  side: 'debit' | 'credit';
  amount: number;
};

describe('0149 — fundacao do livro financeiro central', () => {
  let db: IntegrationDb;
  let getStatement: typeof import(
    '../../src/admin/painel/matriz-ledger-statement.js'
  ).getMatrizLedgerStatement;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      FAREJADOR_ENV: 'test',
      DATABASE_URL: 'postgres://test',
      CHATWOOT_HMAC_SECRET: 'test-secret',
      ADMIN_AUTH_TOKEN: 'emergency-token',
    });
    db = await startPostgres();
    ({ getMatrizLedgerStatement: getStatement } = await import(
      '../../src/admin/painel/matriz-ledger-statement.js'
    ));
  }, 120_000);
  afterAll(async () => { if (db) await stopPostgres(db); });

  async function post(
    environment: 'prod' | 'test',
    sourceType: string,
    sourceId: string,
    kind: string,
    amount: number,
    lines: LedgerLine[],
    options: { dueOn?: string; cashOn?: string; competence?: string } = {},
  ): Promise<string> {
    const result = await db.pool.query<{ id: string }>(
      `SELECT finance.post_matriz_ledger_transaction(
         $1::env_t,$2,$3,$4,$5,$6::date,$7,$8,$9::jsonb,
         $10::date,$11::date,$12::jsonb
       ) id`,
      [
        environment, sourceType, sourceId, kind, amount,
        options.competence ?? '2026-07-01',
        `Fato ${sourceType}`, 'owner:integration',
        JSON.stringify(lines),
        options.dueOn ?? null, options.cashOn ?? null, '{}',
      ],
    );
    return result.rows[0]!.id;
  }

  const receivableLines = (amount: number): LedgerLine[] => [
    { account_code: 'accounts_receivable', account_class: 'asset', side: 'debit', amount },
    { account_code: 'sales_revenue', account_class: 'revenue', side: 'credit', amount },
  ];
  const paymentLines = (amount: number): LedgerLine[] => [
    { account_code: 'accounts_payable', account_class: 'liability', side: 'debit', amount },
    { account_code: 'cash', account_class: 'asset', side: 'credit', amount },
  ];

  it('posta uma partida balanceada, audita e repete sem duplicar', async () => {
    const first = await post(
      'test', 'commerce.order.sale', 'order-001', 'sale', 150, receivableLines(150),
      { dueOn: '2026-08-10' },
    );
    const retry = await post(
      'test', 'commerce.order.sale', 'order-001', 'sale', 150, receivableLines(150),
      { dueOn: '2026-08-10' },
    );
    expect(retry).toBe(first);

    const proof = await db.pool.query(
      `SELECT
         (SELECT count(*)::int FROM finance.matriz_ledger_transactions
           WHERE environment='test' AND source_type='commerce.order.sale'
             AND source_id='order-001') transactions,
         (SELECT count(*)::int FROM finance.matriz_ledger_entries
           WHERE environment='test' AND transaction_id=$1) entries,
         (SELECT count(*)::int FROM audit.events
           WHERE environment='test'
             AND entity_table='finance.matriz_ledger_transactions'
             AND entity_id=$1) audits`,
      [first],
    );
    expect(proof.rows[0]).toEqual({ transactions: 1, entries: 2, audits: 1 });

    await expect(post(
      'test', 'commerce.order.sale', 'order-001', 'sale', 151, receivableLines(151),
      { dueOn: '2026-08-10' },
    )).rejects.toThrow('matriz_ledger_idempotency_conflict');
  });

  it('rejeita partida desbalanceada e cabecalho sem linhas', async () => {
    await expect(post(
      'test', 'commerce.order.sale', 'order-unbalanced', 'sale', 100,
      [
        { account_code: 'accounts_receivable', account_class: 'asset', side: 'debit', amount: 99 },
        { account_code: 'sales_revenue', account_class: 'revenue', side: 'credit', amount: 100 },
      ],
    )).rejects.toThrow('matriz_ledger_unbalanced');

    await expect(db.pool.query(
      `INSERT INTO finance.matriz_ledger_transactions
         (environment,source_type,source_id,transaction_kind,amount,
          competence_on,description,created_by,request_fingerprint)
       VALUES
         ('test','manual.invalid','header-only','manual',10,'2026-07-01',
          'Cabecalho sem partidas','owner:integration',md5('header-only'))`,
    )).rejects.toThrow('matriz_ledger_unbalanced');
  });

  it('isola a mesma origem entre prod/test e torna os fatos imutaveis', async () => {
    const testId = await post(
      'test', 'commerce.order.sale', 'order-env', 'sale', 80, receivableLines(80),
    );
    const prodId = await post(
      'prod', 'commerce.order.sale', 'order-env', 'sale', 80, receivableLines(80),
    );
    expect(prodId).not.toBe(testId);

    await expect(db.pool.query(
      `UPDATE finance.matriz_ledger_transactions
          SET description='Tentativa de reescrita' WHERE id=$1`,
      [testId],
    )).rejects.toThrow('matriz_ledger_immutable');
    await expect(db.pool.query(
      `DELETE FROM finance.matriz_ledger_entries WHERE transaction_id=$1`,
      [testId],
    )).rejects.toThrow('matriz_ledger_immutable');
  });

  it('estorna por nova transacao espelhada sem reescrever o original', async () => {
    const original = await post(
      'test', 'commerce.order.sale', 'order-reversal', 'sale', 230,
      receivableLines(230),
    );
    const reverse = async (sourceId = 'cancel-001') => {
      const result = await db.pool.query<{ id: string }>(
        `SELECT finance.reverse_matriz_ledger_transaction(
           'test',$1,'commerce.order.cancel',$2,'2026-07-02',
           'Cancelamento da venda','owner:integration',NULL,'{}'::jsonb
         ) id`,
        [original, sourceId],
      );
      return result.rows[0]!.id;
    };

    const reversal = await reverse();
    expect(await reverse()).toBe(reversal);
    await expect(reverse('cancel-002'))
      .rejects.toThrow('matriz_ledger_transaction_already_reversed');

    const proof = await db.pool.query(
      `SELECT t.reversal_of_transaction_id,t.transaction_kind,
              array_agg(e.side ORDER BY e.line_no) sides
         FROM finance.matriz_ledger_transactions t
         JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id
        WHERE t.id=$1
        GROUP BY t.id`,
      [reversal],
    );
    expect(proof.rows[0]).toMatchObject({
      reversal_of_transaction_id: original,
      transaction_kind: 'reversal',
      sides: ['credit', 'debit'],
    });
  });

  it('bloqueia estorno direto cujas partidas nao espelham o original', async () => {
    const original = await post(
      'test', 'commerce.order.sale', 'order-bad-reversal', 'sale', 50,
      receivableLines(50),
    );
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const header = await client.query<{ id: string }>(
        `INSERT INTO finance.matriz_ledger_transactions
           (environment,source_type,source_id,transaction_kind,amount,
            competence_on,description,reversal_of_transaction_id,created_by,
            request_fingerprint)
         VALUES
           ('test','manual.bad-reversal','bad-reversal-001','reversal',50,
            '2026-07-02','Estorno propositalmente incorreto',$1,
            'owner:integration',md5('bad-reversal-001'))
         RETURNING id`,
        [original],
      );
      await client.query(
        `INSERT INTO finance.matriz_ledger_entries
           (environment,transaction_id,line_no,account_code,account_class,side,amount)
         VALUES
           ('test',$1,1,'accounts_receivable','asset','debit',50),
           ('test',$1,2,'sales_revenue','revenue','credit',50)`,
        [header.rows[0]!.id],
      );
      await expect(client.query('COMMIT'))
        .rejects.toThrow('matriz_ledger_reversal_lines_mismatch');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('aceita pagamentos parciais, bloqueia excesso e reverte pagamento', async () => {
    const obligation = await post(
      'test', 'commerce.supplier.invoice', 'invoice-001', 'payable', 1000,
      [
        { account_code: 'inventory', account_class: 'asset', side: 'debit', amount: 1000 },
        { account_code: 'accounts_payable', account_class: 'liability', side: 'credit', amount: 1000 },
      ],
      { dueOn: '2026-08-01' },
    );
    const payment400 = await post(
      'test', 'bank.payment', 'payment-400', 'payment', 400, paymentLines(400),
      { cashOn: '2026-07-10' },
    );
    const payment600 = await post(
      'test', 'bank.payment', 'payment-600', 'payment', 600, paymentLines(600),
      { cashOn: '2026-07-11' },
    );
    const record = async (paymentId: string, paidAt: string, reversalId: string | null = null) => {
      const result = await db.pool.query<{ id: string }>(
        `SELECT finance.record_matriz_ledger_payment(
           'test',$1,$2,$3::timestamptz,'owner:integration',$4
         ) id`,
        [obligation, paymentId, paidAt, reversalId],
      );
      return result.rows[0]!.id;
    };
    const firstPayment = await record(payment400, '2026-07-10T12:00:00Z');
    await record(payment600, '2026-07-11T12:00:00Z');

    const paidBalance = await db.pool.query<{ balance: string }>(
      `SELECT finance.matriz_ledger_obligation_balance('test',$1) balance`,
      [obligation],
    );
    expect(Number(paidBalance.rows[0]!.balance)).toBe(0);

    const excess = await post(
      'test', 'bank.payment', 'payment-excess', 'payment', 1, paymentLines(1),
      { cashOn: '2026-07-12' },
    );
    await expect(record(excess, '2026-07-12T12:00:00Z'))
      .rejects.toThrow('matriz_ledger_payment_exceeds_obligation');

    const reversalResult = await db.pool.query<{ id: string }>(
      `SELECT finance.reverse_matriz_ledger_transaction(
         'test',$1,'bank.payment.reversal','payment-400-reversal','2026-07-13',
         'Estorno do pagamento','owner:integration','2026-07-13','{}'::jsonb
       ) id`,
      [payment400],
    );
    const reversalPayment = reversalResult.rows[0]!.id;
    const paymentReversal = await record(
      reversalPayment, '2026-07-13T12:00:00Z', firstPayment,
    );
    expect(await record(
      reversalPayment, '2026-07-13T12:00:00Z', firstPayment,
    )).toBe(paymentReversal);

    const reopened = await db.pool.query<{ balance: string }>(
      `SELECT finance.matriz_ledger_obligation_balance('test',$1) balance`,
      [obligation],
    );
    expect(Number(reopened.rows[0]!.balance)).toBe(400);
  });

  it('nega ao papel parceiro tabelas e funcoes internas do livro', async () => {
    const tables = await db.pool.query<{ relation: string; allowed: boolean }>(
      `SELECT relation,
              has_table_privilege('farejador_partner_app',relation,'SELECT') allowed
         FROM unnest(ARRAY[
           'finance.matriz_ledger_transactions',
           'finance.matriz_ledger_entries',
           'finance.matriz_ledger_payments'
         ]) relation`,
    );
    expect(tables.rows.every((row) => row.allowed === false)).toBe(true);

    const functions = await db.pool.query<{ name: string; allowed: boolean }>(
      `SELECT p.proname name,
              has_function_privilege('farejador_partner_app',p.oid,'EXECUTE') allowed
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='finance'
          AND p.proname IN (
            'post_matriz_ledger_transaction',
            'reverse_matriz_ledger_transaction',
            'record_matriz_ledger_payment',
            'matriz_ledger_obligation_balance'
          )`,
    );
    expect(functions.rows).toHaveLength(4);
    expect(functions.rows.every((row) => row.allowed === false)).toBe(true);
  });

  it('expoe extrato central por competencia e caixa sem vazar campo interno', async () => {
    await post(
      'test', 'finance.statement.proof', 'statement-001', 'cash_sale', 42,
      [
        { account_code: 'cash', account_class: 'asset', side: 'debit', amount: 42 },
        { account_code: 'sales_revenue', account_class: 'revenue', side: 'credit', amount: 42 },
      ],
      { competence: '2026-07-20', cashOn: '2026-07-20' },
    );

    const competence = await getStatement({
      environment: 'test', period: '2026-07', basis: 'competencia', limit: 200,
    }, db.pool);
    const cash = await getStatement({
      environment: 'test', period: '2026-07', basis: 'caixa', limit: 200,
    }, db.pool);
    const row = cash.rows.find((item) => item.source_id === 'statement-001');

    expect(competence.rows.some((item) => item.source_id === 'statement-001')).toBe(true);
    expect(row).toMatchObject({
      direction: 'entrada',
      status: 'registrado',
      origin: 'Financeiro',
      amount: '42.00',
    });
    expect(row).not.toHaveProperty('total_count');
    expect(cash.total).toBeGreaterThanOrEqual(1);
    expect(Number(cash.summary.entradas)).toBeGreaterThanOrEqual(42);
  });
});
