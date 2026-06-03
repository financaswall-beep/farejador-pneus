/**
 * PROVA Tijolo 3.3 / C2 — buscas mostram o estoque da loja que VAI atender.
 *
 * SÓ-LEITURA contra o banco REAL: buscar_produto + getPartnerStockMap só fazem
 * SELECT. Sem transação/rollback (não há o que reverter).
 *
 *   npx tsx --env-file=.env scripts/prova-3.3-c2.ts
 */
import { pool } from '../src/persistence/db.js';
import { executeTool } from '../src/atendente-v2/tools.js';
import { getPartnerStockMap, resolveMunicipioFromBairro } from '../src/atendente-v2/fulfillment.js';

const ENV = 'prod' as const;
const CONV = 'd08d4d61-8668-4ed7-8029-ebd9c4d66a6d';
const PRODUTO = '4252423b-8085-4a07-a02f-d1730bf108a9'; // Pneu 100/80-17, ligado ao estoque do parceiro
const MEDIDA = '100/80-17';
const BAIRRO = 'Manilha';
const MUNICIPIO = 'Itaboraí';

let falhas = 0;
function check(nome: string, cond: boolean, detalhe = ''): void {
  console.log(`${cond ? '✅' : '❌'} ${nome}${detalhe ? '  →  ' + detalhe : ''}`);
  if (!cond) falhas++;
}
function acharProduto(arr: Array<{ product_id: string; total_stock_available: number }>): { total_stock_available: number } | undefined {
  return arr.find((p) => p.product_id === PRODUTO);
}

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    // ════ 0) Contexto: estoque do parceiro vs estoque da matriz pro produto ════
    const pq = (
      await client.query<{ disp: number }>(
        `SELECT (quantity_on_hand - COALESCE(quantity_reserved,0))::int AS disp
         FROM commerce.partner_stock_levels
         WHERE environment=$1 AND product_id=$2 AND is_tracked=true LIMIT 1`,
        [ENV, PRODUTO],
      )
    ).rows[0];
    const partnerQty = pq ? Number(pq.disp) : null;
    const mq = (
      await client.query<{ s: number }>(
        `SELECT total_stock_available::int AS s FROM commerce.product_full WHERE environment=$1 AND product_id=$2 LIMIT 1`,
        [ENV, PRODUTO],
      )
    ).rows[0];
    const matrizQty = mq ? Number(mq.s) : null;
    console.log(`### 0) Estoque do produto 100/80-17 — PARCEIRO=${partnerQty}  MATRIZ=${matrizQty}\n`);

    // ════ 1) getPartnerStockMap casa o município e traz o produto ════
    const municipio = await resolveMunicipioFromBairro(client, ENV, BAIRRO, MUNICIPIO);
    console.log(`### 1) getPartnerStockMap (município resolvido do bairro: ${JSON.stringify(municipio)})`);
    const map = await getPartnerStockMap(client, ENV, municipio);
    check('1.mapa do parceiro tem o produto', map.has(PRODUTO), `produtos no mapa = ${[...map.keys()].length}`);
    check('1.qtd do mapa = estoque do parceiro', map.get(PRODUTO) === partnerQty, `${map.get(PRODUTO)} vs ${partnerQty}`);

    // ════ 2) buscar_produto COM bairro → estoque do PARCEIRO ════
    console.log('\n### 2) buscar_produto COM bairro (Itaboraí) → estoque do PARCEIRO');
    const r2 = JSON.parse(
      await executeTool(client, ENV, CONV, 'buscar_produto', { medida_pneu: MEDIDA, bairro: BAIRRO, municipio: MUNICIPIO }),
    );
    const p2 = acharProduto(r2.produtos ?? []);
    check('2.produto encontrado na busca', !!p2, JSON.stringify(r2).slice(0, 160));
    check('2.estoque mostrado = estoque do PARCEIRO', !!p2 && p2.total_stock_available === partnerQty, `mostrado=${p2?.total_stock_available} parceiro=${partnerQty}`);

    // ════ 3) buscar_produto SEM bairro → estoque da MATRIZ (intacto) ════
    console.log('\n### 3) buscar_produto SEM bairro → estoque da MATRIZ (comportamento antigo, intacto)');
    const r3 = JSON.parse(await executeTool(client, ENV, CONV, 'buscar_produto', { medida_pneu: MEDIDA }));
    const p3 = acharProduto(r3.produtos ?? []);
    check('3.produto encontrado na busca', !!p3);
    check('3.estoque mostrado = estoque da MATRIZ', !!p3 && p3.total_stock_available === matrizQty, `mostrado=${p3?.total_stock_available} matriz=${matrizQty}`);

    if (partnerQty != null && matrizQty != null && partnerQty !== matrizQty) {
      console.log('\n### CONTRASTE (parceiro != matriz)');
      check(
        'C.o bairro REALMENTE trocou o estoque mostrado',
        p2?.total_stock_available !== p3?.total_stock_available,
        `com bairro=${p2?.total_stock_available}  sem bairro=${p3?.total_stock_available}`,
      );
    }
  } catch (e) {
    console.error('\nERRO NA PROVA:', e instanceof Error ? e.stack : e);
    falhas++;
  } finally {
    client.release();
    await pool.end();
  }
  console.log(`\n=== ${falhas === 0 ? 'TUDO VERDE ✅ — C2 provado (busca mostra a loja que atende)' : falhas + ' FALHA(S) ❌'} ===`);
  process.exit(falhas === 0 ? 0 : 1);
}

void main();
