/**
 * PROVA da MATRIZ COMO LOJA (Tijolo 1) no env `test`, chamando o CÓDIGO REAL
 * (decideStoreForItemsGeo) com a flag ROUTING_MATRIZ_AS_STORE ligada. Blinda o
 * comportamento que a obra 2026-06-29 não tinha rede de teste: a matriz concorre
 * no anel como mais uma loja, mas NUNCA fura a régua (só vence quando nenhum
 * parceiro está no pool) e só finge estoque que o GALPÃO realmente tem.
 *
 * Tudo em BEGIN/ROLLBACK — não persiste nada. O galpão (wholesale_stock) e a
 * medida do produto fake (tire_specs) são SEEDADOS dentro da transação e desfeitos
 * no rollback. Distância em LINHA RETA (haversine): NÃO ligue ROUTING_GEO_ROAD_DISTANCE.
 *
 * Pré-requisito: scripts/seed-fake-rede-test.cjs já rodado (cria os geo-*).
 *
 * USO:
 *   npx tsx --env-file=.env scripts/prova-matriz-loja-test.ts
 *
 * Cliente em COPACABANA (a matriz Petiti/SG fica a ~23 km → cabe no anel de ENTREGA
 * de 40 km, fora do de RETIRADA de 15 km). Um 2º cliente perto da matriz cobre a
 * retirada. Casos: M1 matriz ganha entrega · M2 parceiro perto ganha (régua intacta)
 * · M3a matriz vence o only_far · M3b galpão vazio volta ao only_far · M4 retirada
 * perto da matriz · M5 determinismo.
 */

// Flags LIGADAS antes de qualquer import que leia `env` (parse acontece no 1º import).
process.env.ROUTING_MATRIZ_AS_STORE = 'true';
process.env.WHOLESALE_UNIFIED_STOCK = 'true';

const ENV = 'test' as const;
const GEO_MUNI = 'zona-sul-geo';
const COPA = { lat: -22.984613, lng: -43.198278 };
const SLUGS = ['geo-leme', 'geo-tijuca', 'geo-meier', 'geo-niteroi', 'geo-madureira', 'geo-barra', 'geo-itaborai', 'geo-bairro'];
const MEASURE = '90/90-18';

async function main(): Promise<void> {
  // Import dinâmico DEPOIS de setar as flags (senão env.js parseia sem elas).
  const { pool } = await import('../src/persistence/db.js');
  const { decideStoreForItemsGeo, MATRIZ_COORD } = await import('../src/atendente-v2/fulfillment.js');
  const { haversineKm } = await import('../src/shared/geo/haversine.js');
  const { env } = await import('../src/shared/config/env.js');

  if (env.FAREJADOR_ENV !== 'test') throw new Error('ABORTADO: só roda em test.');
  if (!env.ROUTING_MATRIZ_AS_STORE || !env.WHOLESALE_UNIFIED_STOCK) {
    throw new Error('ABORTADO: flags da matriz não ligaram (esperado ROUTING_MATRIZ_AS_STORE + WHOLESALE_UNIFIED_STOCK).');
  }
  if (env.ROUTING_GEO_ROAD_DISTANCE) {
    console.log('⚠️  ROUTING_GEO_ROAD_DISTANCE on — a prova espera haversine; desligue p/ determinismo.');
  }
  console.log('=== PROVA MATRIZ COMO LOJA (test) ===');

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
    if (ids.rowCount !== SLUGS.length) throw new Error(`esperava ${SLUGS.length} geo-fake, achei ${ids.rowCount}. Rode o seed.`);
    const U: Record<string, string> = Object.fromEntries(ids.rows.map((r) => [r.slug, r.unit_id]));
    const slugOf = (unitId: string): string => Object.keys(U).find((s) => U[s] === unitId) ?? unitId.slice(0, 8);

    const prod = await client.query<{ id: string }>(
      `SELECT id FROM commerce.products WHERE environment=$1 AND product_code=$2`,
      [ENV, 'FAKE-REDE-PNEU'],
    );
    const productId = prod.rows[0]!.id;
    const items = [{ product_id: productId, quantity: 1 }];

    const matrizKmFromCopa = Math.round(haversineKm(COPA, MATRIZ_COORD));
    console.log(`  (cliente COPA → matriz Petiti ≈ ${matrizKmFromCopa} km)`);
    // Cliente perto da matriz (~1 km), pra cobrir a RETIRADA (anel pickup 15 km).
    const PERTO_MATRIZ = { lat: MATRIZ_COORD.lat + 0.01, lng: MATRIZ_COORD.lng + 0.01 };

    const decide = (modalidade: 'delivery' | 'pickup', loc: typeof COPA, bairro: string | null) =>
      decideStoreForItemsGeo(client, ENV, {
        municipio: GEO_MUNI,
        items,
        modalidade,
        customerLocation: loc,
        clientNeighborhoodCanonical: bairro,
      });
    const zera = (...slugs: string[]) =>
      client.query(
        `UPDATE commerce.partner_stock_levels SET quantity_on_hand=0, stock_status='out_of_stock' WHERE environment=$1 AND unit_id = ANY($2)`,
        [ENV, slugs.map((s) => U[s]!)],
      );
    const seedGalpao = (qty: number) =>
      client.query(
        `INSERT INTO commerce.wholesale_stock (environment, measure, quantity_on_hand, unit_cost) VALUES ($1,$2,$3,0)`,
        [ENV, MEASURE, qty],
      );
    const seedMedida = () =>
      client.query(
        `INSERT INTO commerce.tire_specs (environment, product_id, tire_size) VALUES ($1,$2,$3)`,
        [ENV, productId, MEASURE],
      );

    // ── M1 — entrega: matriz ganha quando NENHUM parceiro tem o pneu ───────────
    await client.query('BEGIN');
    await seedMedida();
    await seedGalpao(10);
    await zera(...SLUGS); // nenhum parceiro com estoque
    const M1 = await decide('delivery', COPA, 'copacabana');
    check('M1 entrega: nenhum parceiro com estoque → matriz ganha (galpão cheio, ≤40 km)', M1.kind === 'matriz', M1.kind);
    await client.query('ROLLBACK');

    // ── M2 — entrega: parceiro perto com estoque GANHA, matriz não fura a régua ─
    await client.query('BEGIN');
    await seedMedida();
    await seedGalpao(10);
    // todos com estoque (seed padrão): geo-leme ~4km cai no anel 10 → parceiro vence
    const M2 = await decide('delivery', COPA, 'copacabana');
    check(
      'M2 entrega: parceiro perto com estoque ganha (matriz NÃO fura a régua)',
      M2.kind === 'partner',
      M2.kind === 'partner' ? `${slugOf(M2.routing.unitId)} anel${M2.ringKm}` : M2.kind,
    );
    await client.query('ROLLBACK');

    // ── M3a — entrega: matriz (≈23 km) VENCE o only_far (geo-itaborai ≈44 km) ───
    await client.query('BEGIN');
    await seedMedida();
    await seedGalpao(10);
    await zera('geo-leme', 'geo-tijuca', 'geo-meier', 'geo-niteroi', 'geo-madureira', 'geo-barra', 'geo-bairro');
    const M3a = await decide('delivery', COPA, 'copacabana'); // só geo-itaborai tem estoque, mas a 44km
    check('M3a entrega: matriz perto vence o só-longe (galpão cheio) → matriz', M3a.kind === 'matriz', M3a.kind);
    await client.query('ROLLBACK');

    // ── M3b — entrega: galpão VAZIO → matriz não finge → volta ao only_far ──────
    await client.query('BEGIN');
    await seedMedida();
    await seedGalpao(0); // galpão sem o pneu
    await zera('geo-leme', 'geo-tijuca', 'geo-meier', 'geo-niteroi', 'geo-madureira', 'geo-barra', 'geo-bairro');
    const M3b = await decide('delivery', COPA, 'copacabana');
    check(
      'M3b entrega: galpão VAZIO → matriz não finge estoque → only_far (geo-itaborai)',
      M3b.kind === 'only_far' && slugOf(M3b.routing.unitId) === 'geo-itaborai',
      M3b.kind === 'only_far' ? `${slugOf(M3b.routing.unitId)} @${Math.round(M3b.distanceKm)}km` : M3b.kind,
    );
    await client.query('ROLLBACK');

    // ── M4 — retirada: cliente colado na matriz (≤15 km) → matriz ganha ─────────
    await client.query('BEGIN');
    await seedMedida();
    await seedGalpao(10);
    await zera(...SLUGS); // garante que só a matriz compete
    const M4 = await decide('pickup', PERTO_MATRIZ, null);
    check('M4 retirada: cliente colado na matriz (≤15 km) + galpão → matriz', M4.kind === 'matriz', M4.kind);
    await client.query('ROLLBACK');

    // ── M5 — determinismo: mesma entrada → mesmo resultado ─────────────────────
    await client.query('BEGIN');
    await seedMedida();
    await seedGalpao(10);
    await zera(...SLUGS);
    const z1 = await decide('delivery', COPA, 'copacabana');
    const z2 = await decide('delivery', COPA, 'copacabana');
    check('M5 determinismo: 2x → mesmo kind', z1.kind === z2.kind && z1.kind === 'matriz', `${z1.kind}/${z2.kind}`);
    await client.query('ROLLBACK');

    console.log(`\n${fails === 0 ? '✅ TODOS OS CASOS DA MATRIZ-LOJA PASSARAM' : `❌ ${fails} CASO(S) FALHARAM`}`);
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
