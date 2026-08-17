import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('Etapa 3 — compras formais no livro central', () => {
  let db: IntegrationDb;
  let sequence = 0;
  let registerSupplier: typeof import(
    '../../src/admin/painel/queries-fornecedores.js'
  ).registerWholesaleSupplier;
  let registerPurchase: typeof import(
    '../../src/admin/painel/queries-fornecedores-registro.js'
  ).registerWholesalePurchase;
  let confirmPurchase: typeof import(
    '../../src/admin/painel/queries-fornecedores-registro.js'
  ).confirmWholesalePurchase;
  let settlePurchase: typeof import(
    '../../src/admin/painel/queries-financeiro-integridade.js'
  ).settleWholesalePurchasePayment;
  let cancelPurchase: typeof import(
    '../../src/admin/painel/queries-fornecedores-cancel.js'
  ).cancelWholesalePurchase;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
      CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'emergency-token',
      WHOLESALE_FINANCE: 'true', MATRIZ_CENTRAL_LEDGER: 'true',
    });
    vi.resetModules();
    db = await startPostgres();
    ({ registerWholesaleSupplier: registerSupplier }
      = await import('../../src/admin/painel/queries-fornecedores.js'));
    ({ registerWholesalePurchase: registerPurchase, confirmWholesalePurchase: confirmPurchase }
      = await import('../../src/admin/painel/queries-fornecedores-registro.js'));
    ({ settleWholesalePurchasePayment: settlePurchase }
      = await import('../../src/admin/painel/queries-financeiro-integridade.js'));
    ({ cancelWholesalePurchase: cancelPurchase }
      = await import('../../src/admin/painel/queries-fornecedores-cancel.js'));
  }, 180_000);

  afterAll(async () => {
    if (db) await stopPostgres(db);
    process.env.MATRIZ_CENTRAL_LEDGER = 'false';
  });

  async function fixture() {
    sequence += 1;
    const measure = `${210 + sequence}/${40 + sequence}-${12 + sequence}`;
    const product = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.products
         (environment,product_code,product_name,product_type)
       VALUES ('test',$1,$2,'tire') RETURNING id`,
      [`LEDGER-P-${sequence}`, `Pneu livro ${sequence}`],
    );
    await db.pool.query(
      `INSERT INTO commerce.tire_specs
         (environment,product_id,tire_size,width_mm,aspect_ratio,rim_diameter)
       VALUES ('test',$1,$2,$3,$4,$5)`,
      [product.rows[0]!.id, measure, 210 + sequence, 40 + sequence, 12 + sequence],
    );
    const supplier = await registerSupplier({
      environment: 'test',
      name: `Fornecedor livro ${sequence}`,
      phone: `2198${String(sequence).padStart(6, '0')}`,
    }, db.pool);
    return { measure, supplierId: supplier.id };
  }

  it('compra recebida e paga registra estoque contra caixa uma unica vez', async () => {
    const f = await fixture();
    const input = {
      environment: 'test' as const,
      supplier_id: f.supplierId,
      items: [{ measure: f.measure, quantity: 2, unit_cost: 25 }],
      purchased_at: '2026-07-05T14:00:00Z',
      payment_status: 'paid' as const,
      receipt_status: 'received' as const,
      created_by: 'owner:purchase-paid',
      idempotency_key: randomUUID(),
    };
    const purchase = await registerPurchase(input, db.pool);
    expect(await registerPurchase(input, db.pool)).toEqual(purchase);

    const proof = await db.pool.query(
      `SELECT t.transaction_kind,t.amount::text,t.cash_on,
              jsonb_object_agg(e.account_code,e.side ORDER BY e.line_no) entries,
              count(*) OVER ()::int transaction_count
         FROM finance.matriz_ledger_transactions t
         JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id
        WHERE t.environment='test'
          AND t.source_type='commerce.wholesale_purchase.accrual'
          AND t.source_id=$1
        GROUP BY t.id`,
      [purchase.purchase_id],
    );
    expect(proof.rows[0]).toMatchObject({
      transaction_kind: 'purchase_cash',
      amount: '50.00',
      entries: { inventory: 'debit', cash: 'credit' },
      transaction_count: 1,
    });
    expect(proof.rows[0].cash_on).not.toBeNull();
  });

  it('compra em transito transfere ao estoque e depois quita a obrigacao', async () => {
    const f = await fixture();
    const purchase = await registerPurchase({
      environment: 'test',
      supplier_id: f.supplierId,
      items: [{ measure: f.measure, quantity: 3, unit_cost: 40 }],
      purchased_at: '2026-07-06T14:00:00Z',
      payment_status: 'pending',
      due_date: '2026-08-10',
      receipt_status: 'pending',
      created_by: 'owner:purchase-pending',
      idempotency_key: randomUUID(),
    }, db.pool);

    await confirmPurchase({
      environment: 'test', purchase_id: purchase.purchase_id,
      confirmed_by: 'owner:warehouse', idempotency_key: randomUUID(),
    }, db.pool);
    await settlePurchase(purchase.purchase_id, 'test', db.pool, {
      actor_label: 'owner:payment', idempotency_key: randomUUID(),
    });

    const proof = await db.pool.query(
      `SELECT
         (SELECT array_agg(transaction_kind ORDER BY transaction_kind)
            FROM finance.matriz_ledger_transactions
           WHERE environment='test' AND source_id=$1) kinds,
         (SELECT count(*)::int FROM finance.matriz_ledger_payments p
            JOIN finance.matriz_ledger_transactions obligation
              ON obligation.id=p.obligation_transaction_id
           WHERE obligation.source_type='commerce.wholesale_purchase.accrual'
             AND obligation.source_id=$1) payments,
         (SELECT finance.matriz_ledger_obligation_balance('test',id)
            FROM finance.matriz_ledger_transactions
           WHERE source_type='commerce.wholesale_purchase.accrual'
             AND environment='test' AND source_id=$1) balance`,
      [purchase.purchase_id],
    );
    expect(proof.rows[0].kinds).toEqual(['inventory_transfer', 'payable', 'payment']
      .map((kind) => kind === 'payable' ? 'purchase_payable' : kind).sort());
    expect(proof.rows[0].payments).toBe(1);
    expect(Number(proof.rows[0].balance)).toBe(0);
  });

  it('cancelamento nao pago estorna e zera a obrigacao sem apagar o original', async () => {
    const f = await fixture();
    const purchase = await registerPurchase({
      environment: 'test',
      supplier_id: f.supplierId,
      items: [{ measure: f.measure, quantity: 1, unit_cost: 70 }],
      purchased_at: '2026-07-07T14:00:00Z',
      payment_status: 'pending',
      due_date: '2026-08-10',
      receipt_status: 'received',
      created_by: 'owner:purchase-cancel-pending',
      idempotency_key: randomUUID(),
    }, db.pool);
    await cancelPurchase({
      environment: 'test', purchase_id: purchase.purchase_id,
      cancelled_by: 'owner:cancel', reason: 'Fornecedor recolheu a mercadoria',
      idempotency_key: randomUUID(),
    }, db.pool);

    const proof = await db.pool.query(
      `SELECT original.id,
              reversal.reversal_of_transaction_id,
              finance.matriz_ledger_obligation_balance('test',original.id) balance
         FROM finance.matriz_ledger_transactions original
         JOIN finance.matriz_ledger_transactions reversal
           ON reversal.reversal_of_transaction_id=original.id
        WHERE original.environment='test'
          AND original.source_type='commerce.wholesale_purchase.accrual'
          AND original.source_id=$1`,
      [purchase.purchase_id],
    );
    expect(proof.rows).toHaveLength(1);
    expect(proof.rows[0].reversal_of_transaction_id).toBe(proof.rows[0].id);
    expect(Number(proof.rows[0].balance)).toBe(0);
  });

  it('cancela compra que nasceu em transito e zera estoque, transito e obrigacao', async () => {
    const f = await fixture();
    const purchase = await registerPurchase({
      environment: 'test', supplier_id: f.supplierId,
      items: [{ measure: f.measure, quantity: 3, unit_cost: 12.34 }],
      purchased_at: '2026-07-07T14:00:00Z', payment_status: 'pending',
      due_date: '2026-08-10', receipt_status: 'pending',
      created_by: 'owner:purchase-transit-cancel', idempotency_key: randomUUID(),
    }, db.pool);
    await confirmPurchase({ environment: 'test', purchase_id: purchase.purchase_id,
      confirmed_by: 'owner:warehouse', idempotency_key: randomUUID() }, db.pool);
    await cancelPurchase({ environment: 'test', purchase_id: purchase.purchase_id,
      cancelled_by: 'owner:cancel', reason: 'Fornecedor recolheu a mercadoria',
      idempotency_key: randomUUID() }, db.pool);

    const balances = await db.pool.query<{ account_code: string; net: string }>(
      `SELECT e.account_code,
              sum(CASE WHEN e.side='debit' THEN e.amount ELSE -e.amount END)::text net
         FROM finance.matriz_ledger_transactions t
         JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id
        WHERE t.environment='test' AND t.source_id=$1
        GROUP BY e.account_code ORDER BY e.account_code`,
      [purchase.purchase_id],
    );
    expect(balances.rows).toEqual([
      { account_code: 'accounts_payable', net: '0.00' },
      { account_code: 'inventory', net: '0.00' },
      { account_code: 'inventory_in_transit', net: '0.00' },
    ]);
    const sources = await db.pool.query<{ source_type: string }>(
      `SELECT source_type FROM finance.matriz_ledger_transactions
        WHERE environment='test' AND source_id=$1 ORDER BY source_type`,
      [purchase.purchase_id],
    );
    expect(sources.rows.map((row) => row.source_type)).toEqual([
      'commerce.wholesale_purchase.accrual',
      'commerce.wholesale_purchase.cancel',
      'commerce.wholesale_purchase.receipt',
      'commerce.wholesale_purchase.receipt_cancel',
    ]);
    const stock = await db.pool.query<{ quantity_on_hand: number }>(
      `SELECT quantity_on_hand FROM commerce.wholesale_stock
        WHERE environment='test' AND measure=$1`, [f.measure],
    );
    expect(stock.rows[0]?.quantity_on_hand).toBe(0);
  });

  it('cancelamento ja pago preserva caixa e cria valor a recuperar', async () => {
    const f = await fixture();
    const purchase = await registerPurchase({
      environment: 'test',
      supplier_id: f.supplierId,
      items: [{ measure: f.measure, quantity: 1, unit_cost: 90 }],
      purchased_at: '2026-07-08T14:00:00Z',
      payment_status: 'paid',
      receipt_status: 'received',
      created_by: 'owner:purchase-cancel-paid',
      idempotency_key: randomUUID(),
    }, db.pool);
    await cancelPurchase({
      environment: 'test', purchase_id: purchase.purchase_id,
      cancelled_by: 'owner:cancel', reason: 'Aguardando devolucao do fornecedor',
      idempotency_key: randomUUID(),
    }, db.pool);

    const proof = await db.pool.query(
      `SELECT t.source_type,t.transaction_kind,t.reversal_of_transaction_id,
              jsonb_object_agg(e.account_code,e.side ORDER BY e.line_no) entries
         FROM finance.matriz_ledger_transactions t
         JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id
        WHERE t.environment='test' AND t.source_id=$1
        GROUP BY t.id,t.source_type,t.transaction_kind,t.reversal_of_transaction_id
        ORDER BY t.source_type`,
      [purchase.purchase_id],
    );
    expect(proof.rows).toEqual([
      {
        source_type: 'commerce.wholesale_purchase.accrual',
        transaction_kind: 'purchase_cash',
        reversal_of_transaction_id: null,
        entries: { inventory: 'debit', cash: 'credit' },
      },
      {
        source_type: 'commerce.wholesale_purchase.cancel',
        transaction_kind: 'supplier_refund_receivable',
        reversal_of_transaction_id: null,
        entries: { supplier_refund_receivable: 'debit', inventory: 'credit' },
      },
    ]);
    const { getMatrizLedgerOpenItems } =
      await import('../../src/admin/painel/matriz-ledger-open-items.js');
    const { settleMatrizLedgerOpenItem } =
      await import('../../src/admin/painel/matriz-ledger-settlement.js');
    const refund = (await getMatrizLedgerOpenItems('test', db.pool))
      .a_receber.itens.find((item) =>
        item.tipo === 'devolucao_fornecedor' && item.id === purchase.purchase_id);
    expect(refund).toMatchObject({
      valor: '90.00', settlement_mode: 'central_obligation',
    });
    await settleMatrizLedgerOpenItem({
      obligation_id: refund!.obligation_id!, amount: 35,
      idempotency_key: randomUUID(), actor_label: 'owner:supplier-refund',
      environment: 'test',
    }, db.pool);
    expect((await getMatrizLedgerOpenItems('test', db.pool)).a_receber.itens.find(
      (item) => item.obligation_id === refund!.obligation_id,
    )?.valor).toBe('55.00');
  });
});
