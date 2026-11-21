import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { expect } from 'vitest';

type Call = (name: string, args: object) => Promise<any>;

export async function checkMillyExpenseCategories(pool: Pool, call: Call, approve: Call) {
  const list = 'listar_categorias_despesas_matriz';
  const create = 'criar_categoria_despesa_matriz';
  const move = 'reclassificar_despesa_matriz';
  const launch = 'lancar_despesa_matriz';
  const getCategory = async (slug: string) => (await call(list, {})).categorias.find((row: { id: string }) => row.id === slug);
  const expense = {
    category: 'energia', amount: 194, description: 'Conta fictícia da Enel',
    payment_status: 'paid', occurred_at: '2026-01-20T12:00:00-03:00',
    paid_at: '2026-02-20T12:00:00-03:00', competence_month: '2026-01-01',
  };
  expect(await getCategory('outros')).toEqual({ id: 'outros', label: 'Outros' });
  expect(await call(launch, { ...expense, idempotency_key: randomUUID() })).toMatchObject({
    status: 'categoria_indisponivel', executada: false, categoria_solicitada: 'energia',
    categorias_ativas: expect.arrayContaining([{ id: 'outros', label: 'Outros' }]),
  });
  const creation = { label: 'Energia', idempotency_key: randomUUID() };
  const proposal = await call(create, creation);
  expect(proposal).toMatchObject({
    status: 'aguardando_autorizacao', confirmacao: 'conversa',
    dados: { efeitos: { acao: 'criar', categoria: { id: 'energia', label: 'Energia' } } },
  });
  expect(await getCategory('energia')).toBeUndefined();
  const created = await approve(create, creation);
  expect(created).toMatchObject({ categoria: { id: 'energia', label: 'Energia' } });
  expect(await call(create, creation)).toEqual(created);
  expect(await call(create, { label: 'Conta de luz', idempotency_key: randomUUID() })).toMatchObject({
    status: 'categoria_existente', executada: false, categoria: { id: 'energia', label: 'Energia' },
  });
  await pool.query(`UPDATE commerce.matriz_expense_categories SET archived_at=now() WHERE environment='test' AND slug='energia'`);
  expect(await getCategory('energia')).toBeUndefined();
  const reactivate = { label: 'Energia elétrica', idempotency_key: randomUUID() };
  expect(await call(create, reactivate)).toMatchObject({
    status: 'aguardando_autorizacao', dados: { efeitos: { acao: 'reativar', categoria: { id: 'energia', label: 'Energia' } } },
  });
  expect(await approve(create, reactivate)).toMatchObject({ acao: 'reativar', categoria: { id: 'energia' } });

  const { addExpenseReceipt, receiptForExpense, getExpenseReceiptImage } = await import('../../../src/admin/painel/expense-receipts.js');
  const { getMatrizCentralLedgerFinancialTruth } = await import('../../../src/admin/painel/matriz-ledger-financial-read.js');
  const { getMatrizFinanceOverview } = await import('../../../src/admin/painel/matriz-finance-overview.js');
  const { getMatrizLedgerStatement } = await import('../../../src/admin/painel/matriz-ledger-statement.js');
  const { financialMovementsSql } = await import('../../../src/admin/painel/financial-report-sql.js');
  const bytes = Buffer.from('imagem-enel-ficticia-'+randomUUID());
  const { receipt } = await addExpenseReceipt(bytes, 'Teste local', 'test', pool);
  const entry = await approve(launch, {
    ...expense, category: 'outros', idempotency_key: randomUUID(), receipt_id: receipt.id, receipt_confirmed: true,
  });
  expect(entry).toMatchObject({ category: 'outros', amount: '194.00' });
  const expenseId: string = entry.id;
  const found = await call('consultar_despesas_matriz', { periodo: 'mes', mes: '2026-01', busca: 'Enel' });
  expect(found.rows).toEqual([
    expect.objectContaining({ id: expenseId, category: 'outros', amount: 194, has_receipt: true, competence_month: '2026-01-01' }),
  ]);
  const snapshots = async () => {
    const [record, journal, january, february] = await Promise.all([
      pool.query(`SELECT to_jsonb(e)-'category' AS state FROM commerce.matriz_expenses e WHERE id=$1`, [expenseId]),
      pool.query(`SELECT t.* FROM finance.matriz_ledger_transactions t WHERE environment='test' AND source_id=$1`, [expenseId]),
      getMatrizCentralLedgerFinancialTruth('test', pool, '2026-01'),
      getMatrizCentralLedgerFinancialTruth('test', pool, '2026-02'),
    ]);
    return { expense: record.rows[0], journal: journal.rows, january, february };
  };
  const before = await snapshots();
  expect(before.january.competencia.despesas).toBe('194.00');
  expect(before.february.caixa.saidas_registradas).toBe('194.00');
  const args = { expense_id: expenseId, category: 'energia', idempotency_key: randomUUID() };
  expect(await call(move, args)).toMatchObject({
    status: 'aguardando_autorizacao', confirmacao: 'conversa', dados: { efeitos: {
      categoria_atual: { id: 'outros', label: 'Outros' }, categoria_nova: { id: 'energia', label: 'Energia' },
      valor: '194.00', competencia: '2026-01-01', comprovante_id: receipt.id,
      alteracao_caixa: 0, alteracao_resultado_total: 0,
    } },
  });
  const source = async () => (await pool.query('SELECT category FROM commerce.matriz_expenses WHERE id=$1',[expenseId])).rows[0].category;
  expect(await source()).toBe('outros');
  const moved = await approve(move, args);
  expect(moved).toMatchObject({ expense_id: expenseId, categoria_nova: { id: 'energia' } });
  expect(await source()).toBe('energia');
  expect(await call(move, args)).toEqual(moved);
  expect(await snapshots()).toEqual(before);
  expect(await receiptForExpense(expenseId, 'test', pool)).toEqual({ id: receipt.id });
  expect((await getExpenseReceiptImage(receipt.id, true, 'test', pool))?.bytes).toEqual(bytes);
  expect((await getMatrizFinanceOverview('2026-01', 'test', pool)).expenses).toEqual([
    expect.objectContaining({ account: 'expense_energia', label: 'Energia', amount: '194.00' }),
  ]);
  const report = await pool.query(financialMovementsSql, ['test', '2026-01-01', '2026-02-28']);
  expect(report.rows.find((row) => row.source_id === expenseId)).toMatchObject({
    category: 'energia', expense: 194, cash_out: 194,
  });
  const statement = await getMatrizLedgerStatement({ period: '2026-01', basis: 'competencia', environment: 'test' }, pool);
  expect(statement.rows.find((row) => row.source_id === expenseId)?.entries).toEqual(expect.arrayContaining([
    expect.objectContaining({ account_code: 'expense_energia', amount: '194.00' }),
  ]));
  const history = await pool.query(`SELECT payload_before,payload_after FROM audit.events
    WHERE environment='test' AND entity_id=$1 AND event_type='expense_category_changed'`, [expenseId]);
  expect(history.rows).toEqual([{ payload_before: { category: 'outros' }, payload_after: { category: 'energia', reason: null } }]);
}
