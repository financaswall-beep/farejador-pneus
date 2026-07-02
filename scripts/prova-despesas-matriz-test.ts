/**
 * PROVA de INTEGRAÇÃO das DESPESAS DA MATRIZ (0120, flag MATRIZ_EXPENSES) no env
 * `test`, chamando o CÓDIGO REAL (createMatrizExpense / getMatrizExpenses /
 * settleMatrizExpense / removeMatrizExpense). Blinda a Fase A do livro-caixa:
 *   à vista nasce paid+paid_at e NÃO entra no a pagar · pending entra no A PAGAR
 *   · vencida = due < hoje · quitar tira da lista e carimba paid_at · quitar 2x
 *   não sobrescreve · remover é SOFT (deleted_at) e some das contas · pago no mês soma.
 *
 * Escreve direto (INSERT/UPDATE próprios) → seeds descartáveis (created_by
 * 'prova-despesas') e LIMPA tudo (DELETE físico do seed) no finally.
 *
 * USO:
 *   npx tsx --env-file=.env.pooler scripts/prova-despesas-matriz-test.ts
 */

// Flag LIGADA antes de qualquer import que leia `env` (parse no 1º import).
process.env.MATRIZ_EXPENSES = 'true';

const ENV = 'test' as const;
const CREATED_BY = 'prova-despesas';

function isoDate(offsetDays: number): string {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const { pool } = await import('../src/persistence/db.js');
  const { env } = await import('../src/shared/config/env.js');
  const {
    createMatrizExpense, getMatrizExpenses, settleMatrizExpense, removeMatrizExpense,
  } = await import('../src/admin/painel/queries.js');

  if (env.FAREJADOR_ENV !== 'test') throw new Error('ABORTADO: só roda em test.');
  if (!env.MATRIZ_EXPENSES) throw new Error('ABORTADO: MATRIZ_EXPENSES não ligou.');
  console.log('=== PROVA DESPESAS DA MATRIZ (test) ===');

  const client = await pool.connect();
  let fails = 0;
  const check = (name: string, ok: boolean, extra = ''): void => {
    if (!ok) fails++;
    console.log(`  [${ok ? 'OK ' : 'XX '}] ${name}${extra ? ' — ' + extra : ''}`);
  };

  try {
    const base = await getMatrizExpenses(ENV, pool); // régua de partida (test pode ter lixo)
    const basePagar = Number(base.a_pagar_total);
    const baseMes = Number(base.pago_mes_total);

    // ── D1: despesa À VISTA → nasce paid + paid_at, NÃO entra no a pagar, soma no mês ──
    const d1 = await createMatrizExpense(
      { category: 'combustivel', description: 'PROVA gasolina kombi', amount: 120,
        created_by: CREATED_BY, environment: ENV }, pool);
    check('D1 à vista nasce paid com paid_at carimbado',
      d1.payment_status === 'paid' && d1.paid_at != null, `status=${d1.payment_status}`);
    let r = await getMatrizExpenses(ENV, pool);
    check('D1b não entra no A PAGAR', Math.round((Number(r.a_pagar_total) - basePagar) * 100) === 0,
      `${basePagar} → ${r.a_pagar_total}`);
    check('D1c soma no "pago este mês" (+120)', Math.round((Number(r.pago_mes_total) - baseMes) * 100) === 12000,
      `${baseMes} → ${r.pago_mes_total}`);

    // ── D2: despesa A PAGAR sem vencimento → entra no A PAGAR, não vencida ──
    const d2 = await createMatrizExpense(
      { category: 'aluguel', description: 'PROVA aluguel galpão', amount: 800,
        payment_status: 'pending', created_by: CREATED_BY, environment: ENV }, pool);
    r = await getMatrizExpenses(ENV, pool);
    const d2row = r.entries.find((x) => x.id === d2.id);
    check('D2 pending entra no A PAGAR (+800)', Math.round((Number(r.a_pagar_total) - basePagar) * 100) === 80000,
      `${basePagar} → ${r.a_pagar_total}`);
    check('D2b sem vencimento → não vencida', !!d2row && d2row.overdue === false && d2row.due_date == null);

    // ── D3: despesa A PAGAR já VENCIDA (venceu ontem) → overdue + contador ──
    const d3 = await createMatrizExpense(
      { category: 'funcionario', description: 'PROVA diária borracheiro', amount: 150,
        payment_status: 'pending', due_date: isoDate(-1), created_by: CREATED_BY, environment: ENV }, pool);
    r = await getMatrizExpenses(ENV, pool);
    const d3row = r.entries.find((x) => x.id === d3.id);
    check('D3 vencida marca overdue', !!d3row && d3row.overdue === true, d3row ? `due=${d3row.due_date}` : 'NÃO ACHOU');
    check('D3b contador de vencidas ≥ 1', r.a_pagar_vencidos >= 1, String(r.a_pagar_vencidos));

    // ── D4: QUITAR a D2 → sai do a pagar, paid_at carimbado; 2x → erro ──
    const q1 = await settleMatrizExpense(d2.id, ENV, pool);
    check('D4 quitou (paid_at carimbado)', !!q1.paid_at, String(q1.paid_at));
    r = await getMatrizExpenses(ENV, pool);
    const d2after = r.entries.find((x) => x.id === d2.id);
    check('D4b saiu do A PAGAR (sobrou só a D3 = 150)',
      Math.round((Number(r.a_pagar_total) - basePagar) * 100) === 15000, `${r.a_pagar_total}`);
    check('D4c linha virou paid na lista', d2after?.payment_status === 'paid');
    let dupla = false;
    try { await settleMatrizExpense(d2.id, ENV, pool); } catch (e) { dupla = (e as Error).message === 'expense_not_found'; }
    check('D4d quitar 2x NÃO sobrescreve (expense_not_found)', dupla);

    // ── D5: REMOVER a D3 (soft) → some das contas, trilha fica no banco ──
    await removeMatrizExpense(d3.id, ENV, pool);
    r = await getMatrizExpenses(ENV, pool);
    check('D5 removida some da lista', !r.entries.some((x) => x.id === d3.id));
    check('D5b a pagar zerou de volta ao base', Math.round((Number(r.a_pagar_total) - basePagar) * 100) === 0,
      `${r.a_pagar_total}`);
    const trilha = await client.query<{ deleted_at: string | null }>(
      `SELECT deleted_at FROM commerce.matriz_expenses WHERE id = $1`, [d3.id]);
    check('D5c trilha no banco (deleted_at preenchido, linha NÃO apagada)', trilha.rows[0]?.deleted_at != null);
    let dupla2 = false;
    try { await removeMatrizExpense(d3.id, ENV, pool); } catch (e) { dupla2 = (e as Error).message === 'expense_not_found'; }
    check('D5d remover 2x → expense_not_found', dupla2);

    console.log(`\n${fails === 0 ? '✅ DESPESAS DA MATRIZ PROVADAS (à vista + a pagar + vencida + quitar + soft delete)' : `❌ ${fails} CASO(S) FALHARAM`}`);
  } finally {
    await client.query(`DELETE FROM commerce.matriz_expenses WHERE environment = $1 AND created_by = $2`, [ENV, CREATED_BY]);
    client.release();
    await pool.end();
  }
  process.exit(fails > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
