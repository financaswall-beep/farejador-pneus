/**
 * PROVA Tijolo 3.2 — Fundação Bot→Rede (roteamento matriz vs parceiro).
 *
 * Roda contra o banco REAL dentro de UMA transação que aplica a migration 0081 e dá
 * ROLLBACK no fim — NADA persiste em prod (mesmo método das provas das Etapas 0/1/3.1).
 * Exercita o PRÓPRIO executor do bot (executeTool('criar_pedido'/'cancelar_pedido')).
 *
 *   npx tsx --env-file=.env scripts/prova-3.2-fundacao.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pool } from '../src/persistence/db.js';
import { executeTool } from '../src/atendente-v2/tools.js';

const ENV = 'prod' as const;
const CONV = 'd08d4d61-8668-4ed7-8029-ebd9c4d66a6d'; // conversa de teste (contato Vankeiton)
const PRODUTO = '4252423b-8085-4a07-a02f-d1730bf108a9'; // Pneu 100/80-17, ligado ao estoque do parceiro
const STOCK_ID = '4e6899e7-fb7a-4725-917c-29b2826416e1';
const GEO_ITABORAI = 'd640c120-0b85-45ad-a0e1-0bc8ee0d0aa9'; // Manilha / Itaboraí
const UNIT_PARCEIRO = '36203e18-c3fb-4201-bca1-b15c605faa37';
const UNIT_MATRIZ = '1742c95e-727b-4bb8-8dff-c419e3e21297';

let falhas = 0;
function check(nome: string, cond: boolean, detalhe = ''): void {
  console.log(`${cond ? '✅' : '❌'} ${nome}${detalhe ? '  →  ' + detalhe : ''}`);
  if (!cond) falhas++;
}

const argsParceiro = {
  itens: [{ product_id: PRODUTO, quantidade: 1, preco_unitario: 99 }],
  nome_cliente: 'Prova 3.2',
  modalidade: 'delivery',
  endereco_entrega: 'Rua Teste, Manilha, Itaboraí',
  forma_pagamento: 'dinheiro',
  valor_frete: 25, // frete cotado pelo bot — DEVE ser ignorado (parceiro usa 9,90 fixo)
  geo_resolution_id: GEO_ITABORAI,
};

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(readFileSync(resolve('db/migrations/0081_orders_partner_order_link.sql'), 'utf8'));
    console.log('— 0081 aplicada DENTRO da transação (será revertida no fim) —\n');

    // ════ A) PARCEIRO: Itaboraí + produto que o parceiro tem ════
    console.log('### A) Venda roteada ao PARCEIRO (Itaboraí + tem o pneu)');
    const resA = JSON.parse(await executeTool(client, ENV, CONV, 'criar_pedido', argsParceiro));
    check('A.criar_pedido ok', resA.ok === true, JSON.stringify(resA));
    const espA = (
      await client.query(
        `SELECT o.order_number, o.unit_id, o.partner_order_id, o.total_amount, o.payment_method,
                (SELECT COALESCE(SUM(oi.quantity*oi.unit_price),0) FROM commerce.order_items oi WHERE oi.order_id=o.id) AS soma_itens
         FROM commerce.orders o WHERE o.order_number=$1`,
        [resA.order_number],
      )
    ).rows[0];
    check('A.espelho unit_id = PARCEIRO', espA?.unit_id === UNIT_PARCEIRO, espA?.unit_id);
    check('A.espelho tem partner_order_id (link)', !!espA?.partner_order_id, espA?.partner_order_id);
    check('A.espelho total = 108.90 (99 + frete 9,90)', Number(espA?.total_amount) === 108.9, espA?.total_amount);
    check('A.espelho itens a preço CENTRAL (99.00)', Number(espA?.soma_itens) === 99.0, espA?.soma_itens);
    check('A.espelho payment_method = A receber (COD)', espA?.payment_method === 'A receber', espA?.payment_method);
    const poA = (
      await client.query(
        `SELECT source_tag, total_amount, status, delivery_status FROM commerce.partner_orders WHERE id=$1`,
        [espA?.partner_order_id],
      )
    ).rows[0];
    check('A.partner_order source_tag = 2w', poA?.source_tag === '2w', poA?.source_tag);
    check('A.partner_order total = espelho total', Number(poA?.total_amount) === Number(espA?.total_amount), `${poA?.total_amount} vs ${espA?.total_amount}`);
    check('A.partner_order "Em separação" (pending)', poA?.delivery_status === 'pending', poA?.delivery_status);
    const stkA = (await client.query(`SELECT quantity_reserved FROM commerce.partner_stock_levels WHERE id=$1`, [STOCK_ID])).rows[0];
    check('A.estoque reservado 0→1', Number(stkA?.quantity_reserved) === 1, `reserved=${stkA?.quantity_reserved}`);
    const recA = (await client.query(`SELECT amount, status, source_tag FROM finance.partner_receivables WHERE source_order_id=$1`, [espA?.partner_order_id])).rows[0];
    check('A.recebível COD aberto, 2w, 108.90', recA?.status === 'open' && recA?.source_tag === '2w' && Number(recA?.amount) === 108.9, JSON.stringify(recA));

    // ════ A2) IDEMPOTÊNCIA: repetir o MESMO pedido não duplica ════
    console.log('\n### A2) Retry do mesmo pedido (impressão digital)');
    const resA2 = JSON.parse(await executeTool(client, ENV, CONV, 'criar_pedido', argsParceiro));
    check('A2.retry devolve o MESMO pedido', resA2.order_number === resA.order_number, `${resA2.order_number} vs ${resA.order_number}`);
    const stkA2 = (await client.query(`SELECT quantity_reserved FROM commerce.partner_stock_levels WHERE id=$1`, [STOCK_ID])).rows[0];
    check('A2.estoque NÃO duplica reserva (=1)', Number(stkA2?.quantity_reserved) === 1, `reserved=${stkA2?.quantity_reserved}`);
    const nEsp = (await client.query(`SELECT count(*)::int AS n FROM commerce.orders WHERE source_conversation_id=$1 AND partner_order_id IS NOT NULL`, [CONV])).rows[0];
    check('A2.só 1 espelho de parceiro p/ a conversa', nEsp?.n === 1, `n=${nEsp?.n}`);

    // ════ C) TRAVA: cancelar pedido de parceiro escala humano (H3) ════
    console.log('\n### C) Trava: cancelar pedido de parceiro escala humano');
    const resC = JSON.parse(await executeTool(client, ENV, CONV, 'cancelar_pedido', { order_number: resA.order_number, motivo: 'teste' }));
    check('C.cancelar BLOQUEADO (escala humano)', !!resC.erro && /humano/i.test(resC.erro), JSON.stringify(resC));
    const stA = (await client.query(`SELECT status FROM commerce.orders WHERE order_number=$1`, [resA.order_number])).rows[0];
    check('C.pedido continua aberto (não cancelado)', stA?.status === 'open', stA?.status);

    // ════ B) MATRIZ: pickup → não vai pro parceiro (H4) ════
    console.log('\n### B) Venda MATRIZ (pickup → não roteia pro parceiro)');
    const resB = JSON.parse(
      await executeTool(client, ENV, CONV, 'criar_pedido', {
        itens: [{ product_id: PRODUTO, quantidade: 1, preco_unitario: 99 }],
        nome_cliente: 'Prova 3.2 matriz',
        modalidade: 'pickup',
        forma_pagamento: 'dinheiro',
      }),
    );
    check('B.criar_pedido ok', resB.ok === true, JSON.stringify(resB));
    const espB = (await client.query(`SELECT unit_id, partner_order_id, total_amount FROM commerce.orders WHERE order_number=$1`, [resB.order_number])).rows[0];
    check('B.espelho unit_id = MATRIZ', espB?.unit_id === UNIT_MATRIZ, espB?.unit_id);
    check('B.espelho SEM partner_order_id (NULL)', espB?.partner_order_id === null, String(espB?.partner_order_id));
    check('B.matriz total = 99 (pickup, sem frete)', Number(espB?.total_amount) === 99.0, espB?.total_amount);

    await client.query('ROLLBACK');
    console.log('\n— ROLLBACK final: 0081 + todos os dados de teste revertidos. Nada persistiu em prod. —');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\nERRO NA PROVA:', e instanceof Error ? e.stack : e);
    falhas++;
  } finally {
    client.release();
    await pool.end();
  }
  console.log(`\n=== ${falhas === 0 ? 'TUDO VERDE ✅ — Tijolo 3.2 provado ponta-a-ponta' : falhas + ' FALHA(S) ❌'} ===`);
  process.exit(falhas === 0 ? 0 : 1);
}

void main();
