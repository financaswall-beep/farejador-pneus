/**
 * PROVA Tijolo 3.3 / C3b — frete honesto (calcular_frete consulta a loja certa).
 *
 * SÓ-LEITURA contra o banco REAL: calcular_frete não escreve nada (só SELECT +
 * decideStoreForItems). Sem transação/rollback porque não há o que reverter.
 * Mira no risco silencioso: o município do geo casar com PARTNER_COVERAGE.
 *
 *   npx tsx --env-file=.env scripts/prova-3.3-c3b.ts
 */
import { pool } from '../src/persistence/db.js';
import { executeTool } from '../src/atendente-v2/tools.js';
import { decideStoreForItems, resolveMunicipioFromGeo } from '../src/atendente-v2/fulfillment.js';

const ENV = 'prod' as const;
const CONV = 'd08d4d61-8668-4ed7-8029-ebd9c4d66a6d';
const PRODUTO = '4252423b-8085-4a07-a02f-d1730bf108a9'; // Pneu 100/80-17, ligado ao estoque do parceiro
const GEO_ITABORAI = 'd640c120-0b85-45ad-a0e1-0bc8ee0d0aa9'; // Manilha / Itaboraí (região do parceiro)
const UNIT_PARCEIRO = '36203e18-c3fb-4201-bca1-b15c605faa37';
const BAIRRO = 'Manilha';
const MUNICIPIO = 'Itaboraí';

let falhas = 0;
function check(nome: string, cond: boolean, detalhe = ''): void {
  console.log(`${cond ? '✅' : '❌'} ${nome}${detalhe ? '  →  ' + detalhe : ''}`);
  if (!cond) falhas++;
}

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    // ════ 0) Contexto: qual é o frete da MATRIZ pra esse bairro ════
    const mf = (
      await client.query<{ fee: string }>(
        `SELECT delivery_fee::text AS fee FROM commerce.delivery_zones
         WHERE environment=$1 AND geo_resolution_id=$2
         ORDER BY is_available DESC, delivery_fee ASC LIMIT 1`,
        [ENV, GEO_ITABORAI],
      )
    ).rows[0];
    const matrizFee = mf?.fee ?? null;
    console.log(`### 0) Frete da MATRIZ pra Manilha/Itaboraí (delivery_zones) = ${matrizFee}\n`);

    // ════ 1) A peça que pode falhar em SILÊNCIO: o município casa com a cobertura? ════
    console.log('### 1) decideStoreForItems casa o município com PARTNER_COVERAGE');
    const municipio = await resolveMunicipioFromGeo(client, ENV, GEO_ITABORAI);
    console.log('   município resolvido do geo:', JSON.stringify(municipio));
    const decision = await decideStoreForItems(client, ENV, {
      municipio,
      items: [{ product_id: PRODUTO, quantity: 1 }],
    });
    check('1.roteou pro PARCEIRO (decision != null)', decision !== null, JSON.stringify(decision));
    check('1.unidade = parceiro', decision?.unitId === UNIT_PARCEIRO, decision?.unitId ?? 'null');

    // ════ 2) Cadeia completa: calcular_frete COM produto → 9,90 ════
    console.log('\n### 2) calcular_frete COM produto (região do parceiro) → 9,90');
    const r1 = JSON.parse(
      await executeTool(client, ENV, CONV, 'calcular_frete', {
        bairro: BAIRRO,
        municipio: MUNICIPIO,
        produtos: [{ product_id: PRODUTO, quantidade: 1 }],
      }),
    );
    console.log('   resposta:', JSON.stringify(r1));
    check('2.bairro encontrado', r1.encontrado === true, JSON.stringify(r1));
    check('2.geo_resolution_id presente (keystone)', !!r1.geo_resolution_id, String(r1.geo_resolution_id));
    check('2.frete = 9,90 (loja do parceiro)', Number(r1.valor) === 9.9, String(r1.valor));
    check('2.entrega disponível', r1.disponivel === true, String(r1.disponivel));

    // ════ 3) MESMO bairro, SEM produto → frete da MATRIZ (override é condicional) ════
    console.log('\n### 3) calcular_frete SEM produto (mesmo bairro) → frete da matriz, intacto');
    const r2 = JSON.parse(
      await executeTool(client, ENV, CONV, 'calcular_frete', { bairro: BAIRRO, municipio: MUNICIPIO }),
    );
    console.log('   resposta:', JSON.stringify(r2));
    check(
      '3.sem produto NÃO força 9,90 (usa o frete da matriz)',
      matrizFee != null ? Number(r2.valor) === Number(matrizFee) : true,
      `valor=${r2.valor} matrizFee=${matrizFee}`,
    );
    if (matrizFee != null && Number(matrizFee) !== 9.9) {
      check(
        '3.CONTRASTE: matriz != 9,90 → prova que foi o produto que mudou o frete',
        Number(r2.valor) !== 9.9 && Number(r1.valor) === 9.9,
        `matriz=${r2.valor} vs parceiro=${r1.valor}`,
      );
    }
  } catch (e) {
    console.error('\nERRO NA PROVA:', e instanceof Error ? e.stack : e);
    falhas++;
  } finally {
    client.release();
    await pool.end();
  }
  console.log(`\n=== ${falhas === 0 ? 'TUDO VERDE ✅ — C3b provado (frete honesto)' : falhas + ' FALHA(S) ❌'} ===`);
  process.exit(falhas === 0 ? 0 : 1);
}

void main();
