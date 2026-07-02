/**
 * PROVA de INTEGRAÇÃO do FINANCEIRO DO ATACADO (0115, flag WHOLESALE_FINANCE) no env
 * `test`, chamando o CÓDIGO REAL (registerWholesaleSale / registerWholesalePurchase /
 * getWholesaleFinance / settle*). Blinda o fiado dos dois lados:
 *   venda 'pending' → A RECEBER · compra 'pending' → A PAGAR · vencido = due < hoje
 *   · quitar tira da lista e carimba paid_at · quitar 2x não sobrescreve
 *   · venda SEM payment_status segue nascendo 'paid' (o caminho de hoje).
 *
 * Escreve e COMITA (as funções têm transação própria) → seeds descartáveis
 * (medida '98/98-98', comprador/fornecedor 'PROVA-FIN-*') e LIMPA tudo no finally.
 *
 * USO:
 *   npx tsx --env-file=.env.pooler scripts/prova-financeiro-atacado-test.ts
 */

// Flag LIGADA antes de qualquer import que leia `env` (parse no 1º import).
process.env.WHOLESALE_FINANCE = 'true';

const ENV = 'test' as const;
const MEASURE = '98/98-98'; // medida descartável (a '99/99-99' é das outras provas)
const CREATED_BY = 'prova-fin-atacado';

function isoDate(offsetDays: number): string {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const { pool } = await import('../src/persistence/db.js');
  const { env } = await import('../src/shared/config/env.js');
  const {
    registerWholesaleSale, registerWholesalePurchase,
    getWholesaleFinance, settleWholesaleOrderPayment, settleWholesalePurchasePayment,
  } = await import('../src/admin/painel/queries.js');

  if (env.FAREJADOR_ENV !== 'test') throw new Error('ABORTADO: só roda em test.');
  if (!env.WHOLESALE_FINANCE) throw new Error('ABORTADO: WHOLESALE_FINANCE não ligou.');
  console.log('=== PROVA FINANCEIRO DO ATACADO (test) ===');

  const client = await pool.connect();
  let fails = 0;
  let buyerId = '';
  let supplierId = '';
  const check = (name: string, ok: boolean, extra = ''): void => {
    if (!ok) fails++;
    console.log(`  [${ok ? 'OK ' : 'XX '}] ${name}${extra ? ' — ' + extra : ''}`);
  };

  try {
    // ── setup: catálogo + galpão + comprador + fornecedor (descartáveis) ──
    const prod = await client.query<{ id: string }>(`SELECT id FROM commerce.products WHERE environment=$1 LIMIT 1`, [ENV]);
    if (!prod.rows[0]) throw new Error('sem produto no env test pra ancorar o tire_specs');
    await client.query(`DELETE FROM commerce.tire_specs WHERE environment=$1 AND tire_size=$2`, [ENV, MEASURE]);
    await client.query(
      `INSERT INTO commerce.tire_specs (environment, product_id, tire_size, width_mm, aspect_ratio, rim_diameter)
       VALUES ($1,$2,$3,98,98,98)`, [ENV, prod.rows[0].id, MEASURE]);
    await client.query(`DELETE FROM commerce.wholesale_stock WHERE environment=$1 AND measure=$2`, [ENV, MEASURE]);
    await client.query(
      `INSERT INTO commerce.wholesale_stock (environment, measure, quantity_on_hand, unit_cost) VALUES ($1,$2,50,10)`, [ENV, MEASURE]);
    const b = await client.query<{ id: string }>(
      `INSERT INTO commerce.wholesale_customers (environment, name) VALUES ($1,'PROVA-FIN-BORRACHEIRO') RETURNING id`, [ENV]);
    buyerId = b.rows[0]!.id;
    const s = await client.query<{ id: string }>(
      `INSERT INTO commerce.wholesale_suppliers (environment, name) VALUES ($1,'PROVA-FIN-FORNECEDOR') RETURNING id`, [ENV]);
    supplierId = s.rows[0]!.id;
    check('setup: catálogo + galpão 50un + comprador + fornecedor', true);

    const base = await getWholesaleFinance(ENV, pool); // régua de partida (test pode ter lixo)
    const baseRec = Number(base.a_receber_total);
    const basePay = Number(base.a_pagar_total);

    // ── F1: venda FIADO sem vencimento → A RECEBER ──
    const v1 = await registerWholesaleSale(
      { customer_id: buyerId, items: [{ measure: MEASURE, quantity: 2, unit_price: 50 }],
        created_by: CREATED_BY, environment: ENV, payment_status: 'pending' }, pool);
    const r1 = await client.query<{ payment_status: string; paid_at: string | null; due_date: string | null }>(
      `SELECT payment_status, paid_at, due_date FROM commerce.wholesale_orders WHERE id=$1`, [v1.order_id]);
    check('F1 venda fiada nasce pending, sem paid_at', r1.rows[0]?.payment_status === 'pending' && r1.rows[0]?.paid_at == null,
      `status=${r1.rows[0]?.payment_status} paid_at=${r1.rows[0]?.paid_at}`);
    let fin = await getWholesaleFinance(ENV, pool);
    const f1row = fin.receivables.find((x) => x.id === v1.order_id);
    check('F1b aparece no A RECEBER (R$100, sem vencimento, não vencido)',
      !!f1row && Number(f1row.total_amount) === 100 && f1row.due_date == null && f1row.overdue === false,
      f1row ? `${f1row.counterparty} R$${f1row.total_amount}` : 'NÃO ACHOU');
    check('F1c total a receber somou +100', Math.round((Number(fin.a_receber_total) - baseRec) * 100) === 10000,
      `base ${baseRec} → ${fin.a_receber_total}`);

    // ── F2: venda FIADO já VENCIDA (venceu ontem) → vencidos conta ──
    const v2 = await registerWholesaleSale(
      { customer_id: buyerId, items: [{ measure: MEASURE, quantity: 1, unit_price: 80 }],
        created_by: CREATED_BY, environment: ENV, payment_status: 'pending', due_date: isoDate(-1) }, pool);
    fin = await getWholesaleFinance(ENV, pool);
    const f2row = fin.receivables.find((x) => x.id === v2.order_id);
    check('F2 fiado vencido marca overdue', !!f2row && f2row.overdue === true, f2row ? `due=${f2row.due_date}` : 'NÃO ACHOU');
    check('F2b contador de vencidos ≥ 1', fin.a_receber_vencidos >= 1, String(fin.a_receber_vencidos));

    // ── F3: venda SEM payment_status → nasce 'paid' (caminho de hoje intacto) ──
    const v3 = await registerWholesaleSale(
      { customer_id: buyerId, items: [{ measure: MEASURE, quantity: 1, unit_price: 60 }],
        created_by: CREATED_BY, environment: ENV }, pool);
    const r3 = await client.query<{ payment_status: string; paid_at: string | null }>(
      `SELECT payment_status, paid_at FROM commerce.wholesale_orders WHERE id=$1`, [v3.order_id]);
    fin = await getWholesaleFinance(ENV, pool);
    check('F3 venda sem payment_status nasce paid (default de sempre)', r3.rows[0]?.payment_status === 'paid',
      String(r3.rows[0]?.payment_status));
    check('F3b venda à vista NÃO entra no a receber', !fin.receivables.some((x) => x.id === v3.order_id));

    // ── F4: QUITAR o fiado F1 → sai da lista, paid_at carimbado; 2x → erro ──
    const q1 = await settleWholesaleOrderPayment(v1.order_id, ENV, pool);
    check('F4 quitou o fiado (paid_at carimbado)', !!q1.paid_at, String(q1.paid_at));
    fin = await getWholesaleFinance(ENV, pool);
    check('F4b saiu do A RECEBER', !fin.receivables.some((x) => x.id === v1.order_id));
    let dupla = false;
    try { await settleWholesaleOrderPayment(v1.order_id, ENV, pool); } catch (e) { dupla = (e as Error).message === 'receivable_not_found'; }
    check('F4c quitar 2x NÃO sobrescreve (receivable_not_found)', dupla);

    // ── F5: COMPRA a prazo → A PAGAR; quitar → sai ──
    const c1 = await registerWholesalePurchase(
      { supplier_id: supplierId, items: [{ measure: MEASURE, quantity: 5, unit_cost: 10 }],
        created_by: CREATED_BY, environment: ENV, payment_status: 'pending', due_date: isoDate(7) }, pool);
    fin = await getWholesaleFinance(ENV, pool);
    const f5row = fin.payables.find((x) => x.id === c1.purchase_id);
    check('F5 compra a prazo aparece no A PAGAR (R$50, vence em 7d)',
      !!f5row && Number(f5row.total_amount) === 50 && f5row.overdue === false,
      f5row ? `${f5row.counterparty} R$${f5row.total_amount} due=${f5row.due_date}` : 'NÃO ACHOU');
    check('F5b total a pagar somou +50', Math.round((Number(fin.a_pagar_total) - basePay) * 100) === 5000,
      `base ${basePay} → ${fin.a_pagar_total}`);
    await settleWholesalePurchasePayment(c1.purchase_id, ENV, pool);
    fin = await getWholesaleFinance(ENV, pool);
    check('F5c quitou → saiu do A PAGAR', !fin.payables.some((x) => x.id === c1.purchase_id));

    console.log(`\n${fails === 0 ? '✅ FINANCEIRO DO ATACADO PROVADO (fiado dos dois lados + vencido + quitar + caminho de hoje intacto)' : `❌ ${fails} CASO(S) FALHARAM`}`);
  } finally {
    await client.query(
      `DELETE FROM commerce.wholesale_order_items WHERE environment=$1 AND order_id IN
         (SELECT id FROM commerce.wholesale_orders WHERE environment=$1 AND created_by=$2)`, [ENV, CREATED_BY]);
    await client.query(`DELETE FROM commerce.wholesale_orders WHERE environment=$1 AND created_by=$2`, [ENV, CREATED_BY]);
    await client.query(
      `DELETE FROM commerce.wholesale_purchases WHERE environment=$1 AND created_by=$2`, [ENV, CREATED_BY]);
    if (buyerId) await client.query(`DELETE FROM commerce.wholesale_customers WHERE id=$1`, [buyerId]);
    if (supplierId) await client.query(`DELETE FROM commerce.wholesale_suppliers WHERE id=$1`, [supplierId]);
    await client.query(`DELETE FROM commerce.wholesale_stock WHERE environment=$1 AND measure=$2`, [ENV, MEASURE]);
    await client.query(`DELETE FROM commerce.tire_specs WHERE environment=$1 AND tire_size=$2`, [ENV, MEASURE]);
    client.release();
    await pool.end();
  }
  process.exit(fails > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
