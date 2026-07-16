/**
 * PROVA de INTEGRAÇÃO do CANCELAMENTO de venda de atacado (0116) no env `test`,
 * chamando o CÓDIGO REAL (registerWholesaleSale / cancelWholesaleSale / getWholesale*).
 * Blinda: cancelar → status cancelled + TRILHA (quem/quando/por quê) · estoque DEVOLVIDO
 * (espelho da baixa) · fiado cancelado SOME do a receber · resumo faturamento/lucro
 * voltam ao que eram · ranking não conta cancelada · cancelar 2x não sobrescreve.
 *
 * Roda com as flags LIGADAS (baixa + financeiro), setadas ANTES do import dinâmico.
 * Escreve e COMITA → seeds descartáveis ('97/97-97', 'PROVA-CANCEL-*') e LIMPA no finally.
 *
 * USO:
 *   npx tsx --env-file=.env.pooler scripts/prova-cancelar-atacado-test.ts
 */

import { randomUUID } from 'node:crypto';

process.env.WHOLESALE_FINANCE = 'true';
process.env.WHOLESALE_STOCK_DECREMENT = 'true';

const ENV = 'test' as const;
const MEASURE = '97/97-97'; // descartável (98/99 são das outras provas)
const CREATED_BY = 'prova-cancel-atacado';

async function main(): Promise<void> {
  const { pool } = await import('../src/persistence/db.js');
  const { env } = await import('../src/shared/config/env.js');
  const {
    registerWholesaleSale, cancelWholesaleSale, listWholesaleSales,
    getWholesaleFinance, getWholesaleResumo, getWholesaleRanking,
  } = await import('../src/admin/painel/queries.js');

  if (env.FAREJADOR_ENV !== 'test') throw new Error('ABORTADO: só roda em test.');
  if (!env.WHOLESALE_STOCK_DECREMENT || !env.WHOLESALE_FINANCE) throw new Error('ABORTADO: flags não ligaram.');
  console.log('=== PROVA CANCELAR VENDA DE ATACADO (test) ===');

  const client = await pool.connect();
  let fails = 0;
  let buyerId = '';
  const keys: string[] = [];
  const key = () => { const value = randomUUID(); keys.push(value); return value; };
  const check = (name: string, ok: boolean, extra = ''): void => {
    if (!ok) fails++;
    console.log(`  [${ok ? 'OK ' : 'XX '}] ${name}${extra ? ' — ' + extra : ''}`);
  };
  const stockQty = async (): Promise<number | null> => {
    const r = await client.query<{ q: string }>(
      `SELECT quantity_on_hand AS q FROM commerce.wholesale_stock WHERE environment=$1 AND measure=$2`, [ENV, MEASURE]);
    return r.rows[0] ? Number(r.rows[0].q) : null;
  };

  try {
    // ── setup ──
    await client.query(`DELETE FROM commerce.wholesale_stock WHERE environment=$1 AND measure=$2`, [ENV, MEASURE]);
    await client.query(
      `INSERT INTO commerce.wholesale_stock (environment, measure, quantity_on_hand, unit_cost) VALUES ($1,$2,30,10)`, [ENV, MEASURE]);
    const b = await client.query<{ id: string }>(
      `INSERT INTO commerce.wholesale_customers (environment, name) VALUES ($1,'PROVA-CANCEL-BORRACHEIRO') RETURNING id`, [ENV]);
    buyerId = b.rows[0]!.id;
    const resumoBase = await getWholesaleResumo(ENV, pool);
    check('setup: galpão 30un + comprador', (await stockQty()) === 30);

    // ── C1: venda FIADA 4un baixa o galpão; CANCELAR grava trilha ──
    const v1 = await registerWholesaleSale(
      { customer_id: buyerId, items: [{ measure: MEASURE, quantity: 4, unit_price: 25 }],
        created_by: CREATED_BY, environment: ENV, payment_status: 'pending', idempotency_key: key() }, pool);
    check('C1 venda fiada 4un (R$100) baixou 30 → 26', (await stockQty()) === 26, `${await stockQty()}un`);
    const cancelInput = { order_id: v1.order_id, cancelled_by: CREATED_BY,
      reason: 'registro errado (prova)', environment: ENV, idempotency_key: key() };
    const c1 = await cancelWholesaleSale(cancelInput, pool);
    const c1Replay = await cancelWholesaleSale(cancelInput, pool);
    const t1 = await client.query<{ status: string; cancelled_at: string | null; cancelled_by: string | null; cancel_reason: string | null }>(
      `SELECT status, cancelled_at, cancelled_by, cancel_reason FROM commerce.wholesale_orders WHERE id=$1`, [v1.order_id]);
    check('C1b cancelou: status=cancelled + trilha (quem/quando/por quê)',
      t1.rows[0]?.status === 'cancelled' && !!t1.rows[0]?.cancelled_at &&
      t1.rows[0]?.cancelled_by === CREATED_BY && t1.rows[0]?.cancel_reason === 'registro errado (prova)',
      `status=${t1.rows[0]?.status} by=${t1.rows[0]?.cancelled_by}`);
    check('C1c payment_status devolvido no resultado', c1.payment_status === 'pending', c1.payment_status);
    check('C1d replay devolve o cancelamento original', c1Replay.cancelled_at === c1.cancelled_at);

    // ── C2: estoque DEVOLVIDO (26 → 30, espelho da baixa) ──
    check('C2 estoque devolvido ao galpão (26 → 30)', (await stockQty()) === 30, `${await stockQty()}un`);

    // ── C3: fiado cancelado SOME do a receber ──
    const fin = await getWholesaleFinance(ENV, pool);
    check('C3 fiado cancelado fora do A RECEBER', !fin.receivables.some((x) => x.id === v1.order_id));

    // ── C4: resumo (faturamento/lucro) voltou ao valor de antes da venda ──
    const resumoPos = await getWholesaleResumo(ENV, pool);
    check('C4 resumo: faturamento voltou ao de antes (cancelada não conta)',
      Number(resumoPos.faturamento) === Number(resumoBase.faturamento),
      `base ${resumoBase.faturamento} → ${resumoPos.faturamento}`);

    // ── C5: cancelar 2x barra; id inexistente barra ──
    let dupla = false;
    try { await cancelWholesaleSale({ order_id: v1.order_id, cancelled_by: CREATED_BY,
      reason: 'segunda operação de prova', environment: ENV, idempotency_key: key() }, pool); }
    catch (e) { dupla = (e as Error).message === 'sale_already_cancelled'; }
    check('C5 cancelar 2x → sale_already_cancelled (trilha original preservada)', dupla);
    let sumiu = false;
    try { await cancelWholesaleSale({ order_id: '00000000-0000-0000-0000-000000000000',
      cancelled_by: CREATED_BY, reason: 'id inexistente', environment: ENV,
      idempotency_key: key() }, pool); }
    catch (e) { sumiu = (e as Error).message === 'sale_not_found'; }
    check('C5b id inexistente → sale_not_found', sumiu);

    // ── C6: ranking não conta a venda cancelada ──
    const rank = await getWholesaleRanking(ENV, pool) as Array<{ buyer_id: string; orders_count: string }>;
    const mine = rank.find((r) => r.buyer_id === buyerId);
    check('C6 ranking: comprador segue com 0 compras (cancelada não conta)',
      !mine || Number(mine.orders_count) === 0, mine ? `count=${mine.orders_count}` : 'fora do ranking');

    // ── C7: venda PAGA também cancela (e devolve estoque) ──
    const v2 = await registerWholesaleSale(
      { customer_id: buyerId, items: [{ measure: MEASURE, quantity: 2, unit_price: 30 }],
        created_by: CREATED_BY, environment: ENV, idempotency_key: key() }, pool); // sem payment → paid
    check('C7 venda paga 2un baixou 30 → 28', (await stockQty()) === 28, `${await stockQty()}un`);
    await cancelWholesaleSale({ order_id: v2.order_id, cancelled_by: CREATED_BY,
      reason: 'venda paga lançada para prova', environment: ENV, idempotency_key: key() }, pool);
    const resumoFim = await getWholesaleResumo(ENV, pool);
    check('C7b cancelou venda paga: estoque 28 → 30 e resumo de volta ao base',
      (await stockQty()) === 30 && Number(resumoFim.faturamento) === Number(resumoBase.faturamento),
      `${await stockQty()}un / fat ${resumoFim.faturamento}`);

    // ── C8: listagem mostra as duas CANCELADAS (trilha visível) ──
    const lista = await listWholesaleSales(ENV, pool, 30);
    const minhas = lista.filter((x) => [v1.order_id, v2.order_id].includes(x.id));
    check('C8 listagem mostra as 2 vendas com status cancelled',
      minhas.length === 2 && minhas.every((x) => x.status === 'cancelled'),
      `achou ${minhas.length}, status=[${minhas.map((x) => x.status).join(',')}]`);

    console.log(`\n${fails === 0 ? '✅ CANCELAMENTO PROVADO (trilha + devolução + fiado some + resumo/ranking corrigem + 2x barra)' : `❌ ${fails} CASO(S) FALHARAM`}`);
  } finally {
    await client.query(`DELETE FROM audit.events WHERE environment=$1 AND actor_label=$2`, [ENV, CREATED_BY]);
    await client.query(`DELETE FROM audit.operation_idempotency
      WHERE environment=$1 AND idempotency_key=ANY($2)`, [ENV, keys]);
    await client.query(
      `DELETE FROM commerce.wholesale_order_items WHERE environment=$1 AND order_id IN
         (SELECT id FROM commerce.wholesale_orders WHERE environment=$1 AND created_by=$2)`, [ENV, CREATED_BY]);
    await client.query(`DELETE FROM commerce.wholesale_orders WHERE environment=$1 AND created_by=$2`, [ENV, CREATED_BY]);
    if (buyerId) await client.query(`DELETE FROM commerce.wholesale_customers WHERE id=$1`, [buyerId]);
    await client.query(`DELETE FROM commerce.wholesale_stock WHERE environment=$1 AND measure=$2`, [ENV, MEASURE]);
    client.release();
    await pool.end();
  }
  process.exit(fails > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
