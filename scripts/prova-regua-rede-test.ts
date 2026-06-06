/**
 * PROVA do motor de distribuição (Fase 2) no env `test`, chamando o CÓDIGO REAL
 * (`decideStoreForItems`) com as flags ligadas. Tudo em BEGIN/ROLLBACK — não
 * persiste nada (leads simulados e estoque zerado são desfeitos no fim).
 *
 * Pré-requisito: scripts/seed-fake-rede-test.cjs já rodado (4 fake + produto).
 *
 * USO (liga as flags via env var; têm precedência sobre o --env-file):
 *   ROUTING_MULTI_CANDIDATE=true ROUTING_FAIRNESS=true \
 *     npx tsx --env-file=.env scripts/prova-regua-rede-test.ts
 *
 * Casos: determinismo · só-1-candidato (C) · filtro de modo+matriz (D) ·
 * alternância justa A/B (conta lead real em partner_orders) · tenta-o-2º (A sem
 * estoque → B) · ninguém tem → matriz.
 */
import { pool } from '../src/persistence/db.js';
import { decideStoreForItems } from '../src/atendente-v2/fulfillment.js';
import { env } from '../src/shared/config/env.js';

const ENV = 'test' as const;
const SLUGS = ['fake-rede-a', 'fake-rede-b', 'fake-rede-c', 'fake-rede-d'];

async function main(): Promise<void> {
  if (env.FAREJADOR_ENV !== 'test') throw new Error('ABORTADO: só roda em test.');
  console.log('=== PROVA RÉGUA REDE (test) ===');
  console.log('flags:', { ROUTING_MULTI_CANDIDATE: env.ROUTING_MULTI_CANDIDATE, ROUTING_FAIRNESS: env.ROUTING_FAIRNESS });
  if (!env.ROUTING_MULTI_CANDIDATE) {
    console.log('\n⚠️  ROUTING_MULTI_CANDIDATE está OFF — o motor novo não roda. Ligue as flags (ver cabeçalho).');
  }

  const client = await pool.connect();
  let fails = 0;
  const check = (name: string, ok: boolean, extra = ''): void => {
    if (!ok) fails++;
    console.log(`  [${ok ? 'OK ' : 'XX '}] ${name}${extra ? ' — ' + extra : ''}`);
  };

  try {
    const ids = await client.query<{ slug: string; unit_id: string }>(
      `SELECT slug, unit_id FROM network.partner_units WHERE environment=$1 AND slug = ANY($2)`,
      [ENV, SLUGS],
    );
    if (ids.rowCount !== 4) throw new Error(`esperava 4 fake, achei ${ids.rowCount}. Rode o seed primeiro.`);
    const U: Record<string, string> = Object.fromEntries(ids.rows.map((r) => [r.slug, r.unit_id]));

    const prod = await client.query<{ id: string }>(
      `SELECT id FROM commerce.products WHERE environment=$1 AND product_code=$2`,
      [ENV, 'FAKE-REDE-PNEU'],
    );
    const productId = prod.rows[0]!.id;
    const items = [{ product_id: productId, quantity: 1 }];

    await client.query('BEGIN');

    const decide = (municipio: string) => decideStoreForItems(client, ENV, { municipio, items });
    const addLead = (unitId: string) =>
      client.query(
        `INSERT INTO commerce.partner_orders (environment, unit_id, total_amount, source_tag) VALUES ($1,$2,200,'2w')`,
        [ENV, unitId],
      );
    const zera = (unitId: string) =>
      client.query(
        `UPDATE commerce.partner_stock_levels SET quantity_on_hand=0, stock_status='out_of_stock' WHERE environment=$1 AND unit_id=$2`,
        [ENV, unitId],
      );

    // 1. Determinismo (estado limpo): rio 2x → mesma loja.
    const d1 = await decide('rio de janeiro');
    const d2 = await decide('rio de janeiro');
    check('determinismo: rio 2x → mesma loja', !!d1 && !!d2 && d1.unitId === d2.unitId, d1 ? `loja=${d1.unitId.slice(0, 8)}` : 'null');

    // 2. Só 1 candidato: são gonçalo → C (delivery, com estoque).
    const sg = await decide('sao goncalo');
    check('sao goncalo → C', !!sg && sg.unitId === U['fake-rede-c'], sg ? sg.unitId.slice(0, 8) : 'null(matriz)');

    // 3. Filtro de modo + matriz: maricá → D é só-retirada e sem estoque → matriz (null).
    const mc = await decide('marica');
    check('marica (D pickup-only, sem estoque) → matriz', mc === null, mc ? 'veio parceiro!' : 'null');

    // 4. Alternância justa A/B: decide → registra o lead real → repete. |A−B| ≤ 1.
    const N = 20;
    const counts: Record<string, number> = {};
    for (let i = 0; i < N; i++) {
      const d = await decide('rio de janeiro');
      if (!d) { fails++; console.log('   rio deu matriz no meio do loop!'); break; }
      counts[d.unitId] = (counts[d.unitId] ?? 0) + 1;
      await addLead(d.unitId); // conta como lead recebido (a régua lê isto na próxima volta)
    }
    const a = counts[U['fake-rede-a']!] ?? 0;
    const b = counts[U['fake-rede-b']!] ?? 0;
    check(`alternância justa A/B (N=${N})`, Math.abs(a - b) <= 1 && a + b === N, `A=${a} B=${b}`);

    // 5. Tenta o 2º: A sem estoque → B (antes da matriz).
    await zera(U['fake-rede-a']!);
    const noA = await decide('rio de janeiro');
    check('A sem estoque → B (tenta o 2º)', !!noA && noA.unitId === U['fake-rede-b'], noA ? noA.unitId.slice(0, 8) : 'null');

    // 6. Ninguém tem → matriz: A e B sem estoque → null.
    await zera(U['fake-rede-b']!);
    const noAB = await decide('rio de janeiro');
    check('A e B sem estoque → matriz', noAB === null, noAB ? 'veio parceiro!' : 'null');

    await client.query('ROLLBACK'); // desfaz leads simulados + estoque zerado
    console.log(`\n${fails === 0 ? '✅ TODOS OS CASOS PASSARAM' : `❌ ${fails} CASO(S) FALHARAM`}`);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* noop */ }
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
  process.exit(fails > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
