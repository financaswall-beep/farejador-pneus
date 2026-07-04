/**
 * PROVA — MATRIZ CONCORRE DE IGUAL (flag ROUTING_MATRIZ_COMPETES, decisão do dono 2026-07-03).
 * Vai ALÉM do backstop (ROUTING_MATRIZ_AS_STORE): com a flag on, a matriz TOMA o pedido do
 * parceiro campeão quando está ESTRITAMENTE mais perto do cliente que TODO parceiro do pool.
 * Empate / parceiro mais perto → parceiro fica (a régua entre parceiros não muda).
 *
 * Chama o CÓDIGO REAL (decideStoreForItemsGeo). Tudo em BEGIN/ROLLBACK — não persiste nada.
 * Distância em LINHA RETA (haversine): NÃO ligue ROUTING_GEO_ROAD_DISTANCE.
 * Pré-requisito: scripts/seed-fake-rede-test.cjs já rodado (cria os geo-*).
 *
 * Cenário (coords reais das fake): matriz Petiti/SG; geo-niteroi a ~12 km da matriz (vizinho
 * perto); COPA a ~24 km da matriz com geo-leme a ~4 km de COPA.
 *  - C1a RETIRADA colado na matriz (~1,5 km) + parceiro no pool → MATRIZ vence (mais perto).
 *  - C1b MESMO ponto, galpão VAZIO → parceiro vence (prova que ERA head-to-head real).
 *  - C2  ENTREGA em COPA: geo-leme (~4 km) mais perto que a matriz (~24 km) → PARCEIRO fica.
 *  - C3  determinismo.
 *
 * USO: npx tsx --env-file=.env.pooler scripts/prova-matriz-compete-test.ts
 */

// Flags LIGADAS antes de qualquer import que leia `env` (parse acontece no 1º import).
process.env.ROUTING_MATRIZ_AS_STORE = 'true';
process.env.ROUTING_MATRIZ_COMPETES = 'true';
process.env.WHOLESALE_UNIFIED_STOCK = 'true';

const ENV = 'test' as const;
const GEO_MUNI = 'zona-sul-geo';
const COPA = { lat: -22.984613, lng: -43.198278 };
const SLUGS = ['geo-leme', 'geo-tijuca', 'geo-meier', 'geo-niteroi', 'geo-madureira', 'geo-barra', 'geo-itaborai', 'geo-bairro'];
const MEASURE = '90/90-18';

async function main(): Promise<void> {
  const { pool } = await import('../src/persistence/db.js');
  const { decideStoreForItemsGeo, MATRIZ_COORD } = await import('../src/atendente-v2/fulfillment.js');
  const { haversineKm } = await import('../src/shared/geo/haversine.js');
  const { env } = await import('../src/shared/config/env.js');

  if (env.FAREJADOR_ENV !== 'test') throw new Error('ABORTADO: só roda em test.');
  if (!env.ROUTING_MATRIZ_COMPETES || !env.WHOLESALE_UNIFIED_STOCK) {
    throw new Error('ABORTADO: flags não ligaram (esperado ROUTING_MATRIZ_COMPETES + WHOLESALE_UNIFIED_STOCK).');
  }
  if (env.ROUTING_GEO_ROAD_DISTANCE) {
    console.log('⚠️  ROUTING_GEO_ROAD_DISTANCE on — a prova espera haversine; desligue p/ determinismo.');
  }
  console.log('=== PROVA MATRIZ CONCORRE DE IGUAL (test) ===');

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

    // Cliente colado na matriz (~1,5 km) — geo-niteroi (~12 km) é o parceiro perto que sobra no anel.
    const PERTO_MATRIZ = { lat: MATRIZ_COORD.lat + 0.01, lng: MATRIZ_COORD.lng + 0.01 };
    console.log(`  (colado na matriz → matriz ≈ ${Math.round(haversineKm(PERTO_MATRIZ, MATRIZ_COORD))} km; COPA → matriz ≈ ${Math.round(haversineKm(COPA, MATRIZ_COORD))} km)`);

    const decide = (modalidade: 'delivery' | 'pickup', loc: typeof COPA, bairro: string | null) =>
      decideStoreForItemsGeo(client, ENV, {
        municipio: GEO_MUNI,
        items,
        modalidade,
        customerLocation: loc,
        clientNeighborhoodCanonical: bairro,
      });
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

    // ── C1a — retirada colado na matriz + parceiro no pool + galpão cheio → MATRIZ vence ──
    await client.query('BEGIN');
    await seedMedida();
    await seedGalpao(10); // parceiros ficam com estoque (NÃO zera) → geo-niteroi compete
    const C1a = await decide('pickup', PERTO_MATRIZ, null);
    check('C1a: matriz mais perto que o parceiro (galpão cheio) → matriz TOMA o pedido', C1a.kind === 'matriz', C1a.kind);
    await client.query('ROLLBACK');

    // ── C1b — mesmo ponto, galpão VAZIO → parceiro vence (prova head-to-head real) ────────
    await client.query('BEGIN');
    await seedMedida();
    await seedGalpao(0); // matriz sem estoque → não pode tomar
    const C1b = await decide('pickup', PERTO_MATRIZ, null);
    check(
      'C1b: mesmo ponto, galpão vazio → parceiro (prova que HAVIA parceiro no pool)',
      C1b.kind === 'partner',
      C1b.kind === 'partner' ? slugOf(C1b.routing.unitId) : C1b.kind,
    );
    await client.query('ROLLBACK');

    // ── C2 — entrega em COPA: parceiro (geo-leme ~4km) mais perto que a matriz (~24km) → parceiro ──
    await client.query('BEGIN');
    await seedMedida();
    await seedGalpao(10); // galpão cheio, mas a matriz NÃO é a mais perto → guarda segura
    const C2 = await decide('delivery', COPA, 'copacabana');
    check(
      'C2: parceiro mais perto que a matriz → parceiro fica (guarda do "só quando mais perto")',
      C2.kind === 'partner',
      C2.kind === 'partner' ? slugOf(C2.routing.unitId) : C2.kind,
    );
    await client.query('ROLLBACK');

    // ── C3 — determinismo ─────────────────────────────────────────────────────────────────
    await client.query('BEGIN');
    await seedMedida();
    await seedGalpao(10);
    const z1 = await decide('pickup', PERTO_MATRIZ, null);
    const z2 = await decide('pickup', PERTO_MATRIZ, null);
    check('C3 determinismo: 2x → mesmo kind (matriz)', z1.kind === z2.kind && z1.kind === 'matriz', `${z1.kind}/${z2.kind}`);
    await client.query('ROLLBACK');

    console.log(`\n${fails === 0 ? '✅ TODOS OS CASOS DA MATRIZ-CONCORRE PASSARAM' : `❌ ${fails} CASO(S) FALHARAM`}`);
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
