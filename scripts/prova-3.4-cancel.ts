/**
 * PROVA Tijolo 3.4 — propagação REAL de cancelamento + status do parceiro no consultar (C6).
 *
 * Roda contra o banco REAL dentro de UMA transação que aplica a 0081 e dá ROLLBACK no
 * fim — NADA persiste em prod (mesmo método das provas 3.1/3.2/3.3). Exercita o PRÓPRIO
 * executor do bot (executeTool('criar_pedido'/'consultar_pedido'/'cancelar_pedido')).
 *
 *   npx tsx --env-file=.env scripts/prova-3.4-cancel.ts
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

let falhas = 0;
function check(nome: string, cond: boolean, detalhe = ''): void {
  console.log(`${cond ? '✅' : '❌'} ${nome}${detalhe ? '  →  ' + detalhe : ''}`);
  if (!cond) falhas++;
}

function pedidoDe(resp: string, orderNumber: string): Record<string, unknown> | undefined {
  const j = JSON.parse(resp) as { pedidos?: Record<string, unknown>[] };
  return (j.pedidos ?? []).find((p) => p.order_number === orderNumber);
}

const argsParceiro = (qtd: number, nome: string) => ({
  itens: [{ product_id: PRODUTO, quantidade: qtd, preco_unitario: 99 }],
  nome_cliente: nome,
  modalidade: 'delivery',
  endereco_entrega: 'Rua Teste, Manilha, Itaboraí',
  forma_pagamento: 'dinheiro',
  valor_frete: 25,
  geo_resolution_id: GEO_ITABORAI,
});

async function reservedDe(client: import('pg').PoolClient): Promise<number> {
  const r = await client.query<{ q: string }>(
    `SELECT COALESCE(quantity_reserved, 0)::text AS q FROM commerce.partner_stock_levels WHERE id=$1`,
    [STOCK_ID],
  );
  return Number(r.rows[0]?.q ?? 0);
}

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(readFileSync(resolve('db/migrations/0081_orders_partner_order_link.sql'), 'utf8'));
    console.log('— 0081 aplicada DENTRO da transação (será revertida no fim) —\n');

    const reservedBase = await reservedDe(client);
    console.log(`baseline reserva do estoque-teste = ${reservedBase}\n`);

    // ════ 1) Cria pedido de parceiro (Em separação) ════
    console.log('### 1) Cria venda roteada ao PARCEIRO (Itaboraí + tem o pneu)');
    const res1 = JSON.parse(await executeTool(client, ENV, CONV, 'criar_pedido', argsParceiro(1, 'Prova 3.4')));
    check('1.criar_pedido ok', res1.ok === true, JSON.stringify(res1));
    const o1 = (
      await client.query(`SELECT id, partner_order_id, status FROM commerce.orders WHERE order_number=$1`, [res1.order_number])
    ).rows[0];
    check('1.espelho tem partner_order_id', !!o1?.partner_order_id, o1?.partner_order_id);
    check('1.reserva subiu (+1)', (await reservedDe(client)) === reservedBase + 1, `reserved=${await reservedDe(client)}`);

    // ════ 2) C6: consultar ANTES do cancelamento → "em separação" ════
    console.log('\n### 2) C6: consultar_pedido mostra a situação REAL do parceiro');
    const cons1 = await executeTool(client, ENV, CONV, 'consultar_pedido', { order_number: res1.order_number });
    const p1 = pedidoDe(cons1, res1.order_number);
    check('2.consultar marca eh_parceiro', p1?.eh_parceiro === true, JSON.stringify(p1?.eh_parceiro));
    check('2.situacao_parceiro = "em separação"', p1?.situacao_parceiro === 'em separação', String(p1?.situacao_parceiro));

    // ════ 3) Cancelamento REAL (happy path) ════
    console.log('\n### 3) cancelar_pedido propaga: dono + reserva + recebível + espelho');
    const canc = JSON.parse(
      await executeTool(client, ENV, CONV, 'cancelar_pedido', { order_number: res1.order_number, motivo: 'cliente_desistiu' }),
    );
    check('3.cancelar ok', canc.ok === true, JSON.stringify(canc));
    const po1 = (
      await client.query(`SELECT status, delivery_status FROM commerce.partner_orders WHERE id=$1`, [o1?.partner_order_id])
    ).rows[0];
    check('3.partner_order status = cancelled', po1?.status === 'cancelled', po1?.status);
    check('3.reserva LIBERADA (volta ao baseline)', (await reservedDe(client)) === reservedBase, `reserved=${await reservedDe(client)}`);
    const rec1 = (
      await client.query(`SELECT status FROM finance.partner_receivables WHERE source_order_id=$1`, [o1?.partner_order_id])
    ).rows[0];
    check('3.recebível estornado (cancelled)', rec1?.status === 'cancelled', rec1?.status);
    const esp1 = (await client.query(`SELECT status FROM commerce.orders WHERE order_number=$1`, [res1.order_number])).rows[0];
    check('3.espelho commerce.orders cancelled', esp1?.status === 'cancelled', esp1?.status);

    // ════ 4) C6: consultar DEPOIS → "cancelado" ════
    console.log('\n### 4) C6: consultar pós-cancelamento mostra "cancelado"');
    const cons2 = await executeTool(client, ENV, CONV, 'consultar_pedido', { order_number: res1.order_number });
    const p2 = pedidoDe(cons2, res1.order_number);
    check('4.situacao_parceiro = "cancelado"', p2?.situacao_parceiro === 'cancelado', String(p2?.situacao_parceiro));

    // ════ 5) GUARD: pedido já DESPACHADO → cancelar escala humano ════
    console.log('\n### 5) Guard: pedido já despachado NÃO é cancelado pelo bot (escala humano)');
    const res2 = JSON.parse(await executeTool(client, ENV, CONV, 'criar_pedido', argsParceiro(2, 'Prova 3.4 despacho')));
    check('5.criar 2º pedido ok', res2.ok === true, JSON.stringify(res2));
    const o2 = (
      await client.query(`SELECT id, partner_order_id FROM commerce.orders WHERE order_number=$1`, [res2.order_number])
    ).rows[0];
    await client.query(`UPDATE commerce.partner_orders SET delivery_status='dispatched' WHERE id=$1`, [o2?.partner_order_id]);
    const reservedAntes = await reservedDe(client);
    const canc2 = JSON.parse(
      await executeTool(client, ENV, CONV, 'cancelar_pedido', { order_number: res2.order_number, motivo: 'teste' }),
    );
    check('5.cancelar BLOQUEADO (escala humano)', !!canc2.erro && /humano/i.test(canc2.erro), JSON.stringify(canc2));
    const po2 = (await client.query(`SELECT status FROM commerce.partner_orders WHERE id=$1`, [o2?.partner_order_id])).rows[0];
    check('5.partner_order NÃO cancelado (segue confirmed)', po2?.status !== 'cancelled', po2?.status);
    const esp2 = (await client.query(`SELECT status FROM commerce.orders WHERE order_number=$1`, [res2.order_number])).rows[0];
    check('5.espelho segue open (intacto)', esp2?.status === 'open', esp2?.status);
    check('5.reserva intacta (não liberou)', (await reservedDe(client)) === reservedAntes, `reserved=${await reservedDe(client)}`);

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
  console.log(`\n=== ${falhas === 0 ? 'TUDO VERDE ✅ — Tijolo 3.4 (cancel + C6) provado ponta-a-ponta' : falhas + ' FALHA(S) ❌'} ===`);
  process.exit(falhas === 0 ? 0 : 1);
}

void main();
