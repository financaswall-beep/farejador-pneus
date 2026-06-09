/**
 * PROVA da PROXIMIDADE-PRIMEIRO (Fase 1) no env `test`, chamando o CÓDIGO REAL
 * (decideStoreForItemsGeo + os dois resolvedores de candidatos). Tudo em BEGIN/ROLLBACK.
 * Usa distância em LINHA RETA (haversine): a flag ROUTING_GEO_ROAD_DISTANCE é forçada
 * OFF aqui (determinismo, sem rede). A flag ROUTING_PROXIMITY_FIRST é forçada ON.
 *
 * Estas duas flags são setadas em process.env ANTES de qualquer import do código
 * (que lê env no load) — por isso os imports são DINÂMICOS (await import), depois do set.
 *
 * Pré-requisito: scripts/seed-fake-rede-test.cjs já rodado (cria prox-* e geo-*).
 *
 * USO:
 *   npx tsx --env-file=.env scripts/prova-proximidade-rede-test.ts
 *
 * Casos:
 *   1. Muro caiu (resolvedores): o resolver de CIDADE não enxerga prox-madureira pra um
 *      cliente de Caxias; o resolver de PROXIMIDADE enxerga (≥30 lojas).
 *   2. Divisa (motor): cliente em Caxias, RETIRADA → o motor escolhe uma loja a ≤15 km
 *      (o muro caiu — antes ia pra matriz).
 *   3. Teto de 15 km: cliente longe de todas → only_far (ninguém no anel de retirada).
 *   4. Escala/determinismo: com 30 lojas, 2× a mesma entrada → a MESMA loja.
 */

// Flags ANTES dos imports (env parseia no load). NÃO mexe no .env global.
process.env.ROUTING_PROXIMITY_FIRST = 'true';
process.env.ROUTING_GEO_ROAD_DISTANCE = 'false';

const { pool } = await import('../src/persistence/db.js');
const { decideStoreForItemsGeo, resolveUnitCandidates, resolveUnitCandidatesByProximity } = await import(
  '../src/atendente-v2/fulfillment.js'
);
const { env } = await import('../src/shared/config/env.js');

const ENV = 'test' as const;
const CAXIAS = { lat: -22.8, lng: -43.32 }; // ~8 km de prox-madureira, cidade diferente
const SOUTH = { lat: -22.97, lng: -43.22 }; // centro do aglomerado prox-01..29
const FAR = { lat: -23.2, lng: -44.0 }; // longe de todas as lojas (>15 km)

async function main(): Promise<void> {
  if (env.FAREJADOR_ENV !== 'test') throw new Error('ABORTADO: só roda em test.');
  if (!env.ROUTING_PROXIMITY_FIRST) throw new Error('ABORTADO: ROUTING_PROXIMITY_FIRST não ligou (ordem de import?).');
  console.log('=== PROVA PROXIMIDADE-PRIMEIRO (test) ===');

  const client = await pool.connect();
  let fails = 0;
  const check = (name: string, ok: boolean, extra = ''): void => {
    if (!ok) fails++;
    console.log(`  [${ok ? 'OK ' : 'XX '}] ${name}${extra ? ' — ' + extra : ''}`);
  };

  try {
    const prod = await client.query<{ id: string }>(
      `SELECT id FROM commerce.products WHERE environment=$1 AND product_code=$2`,
      [ENV, 'FAKE-REDE-PNEU'],
    );
    if (prod.rowCount === 0) throw new Error('produto FAKE-REDE-PNEU não achado. Rode o seed.');
    const productId = prod.rows[0]!.id;
    const items = [{ product_id: productId, quantity: 1 }];

    const ids = await client.query<{ slug: string; unit_id: string }>(
      `SELECT slug, unit_id FROM network.partner_units WHERE environment=$1 AND slug = ANY($2)`,
      [ENV, ['prox-madureira', 'geo-madureira']],
    );
    const U: Record<string, string> = Object.fromEntries(ids.rows.map((r) => [r.slug, r.unit_id]));
    if (!U['prox-madureira']) throw new Error('prox-madureira não achado. Rode o seed atualizado.');
    const madureiraIds = new Set([U['prox-madureira'], U['geo-madureira']].filter(Boolean));

    const decide = (loc: { lat: number; lng: number }) =>
      decideStoreForItemsGeo(client, ENV, {
        municipio: 'duque de caxias', // proximidade ignora o município; só satisfaz a assinatura
        items,
        modalidade: 'pickup',
        customerLocation: loc,
        clientNeighborhoodCanonical: null,
      });

    await client.query('BEGIN');

    // 1 — Muro caiu (resolvedores). O resolver de CIDADE p/ "duque de caxias" NÃO traz
    //     prox-madureira (loja cobre 'proximidade-prox', não Caxias). O de PROXIMIDADE traz.
    const city = await resolveUnitCandidates(client, ENV, 'duque de caxias');
    const prox = await resolveUnitCandidatesByProximity(client, ENV);
    const cityHasMad = city.some((c) => madureiraIds.has(c.ctx.unitId));
    const proxHasMad = prox.some((c) => c.ctx.unitId === U['prox-madureira']);
    check(
      '1a muro de pé no resolver de CIDADE: Caxias NÃO enxerga prox-madureira',
      !cityHasMad,
      `cidade=${city.length} candidatos`,
    );
    check(
      '1b muro CAI na proximidade: prox-madureira entra + escala (≥30 lojas)',
      proxHasMad && prox.length >= 30,
      `proximidade=${prox.length} candidatos`,
    );

    // 2 — Divisa (motor): cliente em Caxias, retirada → loja a ≤15 km (antes: matriz).
    const d = await decide(CAXIAS);
    check(
      '2 divisa: Caxias→retirada escolhe loja a ≤15 km (muro caiu, não vai pra matriz)',
      d.kind === 'partner' && d.distanceKm <= 15 && madureiraIds.has(d.routing.unitId),
      d.kind === 'partner' ? `loja@${Math.round(d.distanceKm)}km anel${d.ringKm}` : d.kind,
    );

    // 3 — Teto de 15 km: cliente longe de tudo → ninguém no anel de retirada → only_far.
    const far = await decide(FAR);
    check(
      '3 teto 15 km: cliente longe → only_far (nenhuma loja dentro do anel de retirada)',
      far.kind === 'only_far',
      far.kind === 'only_far' ? `${Math.round(far.distanceKm)}km ${far.unitName}` : far.kind,
    );

    // 4 — Escala/determinismo: 30 lojas, cliente no meio do aglomerado, 2× → mesma loja.
    const s1 = await decide(SOUTH);
    const s2 = await decide(SOUTH);
    check(
      '4 escala+determinismo: 30 lojas, 2× → mesma loja (motor determinístico)',
      s1.kind === 'partner' && s2.kind === 'partner' && s1.routing.unitId === s2.routing.unitId,
      s1.kind === 'partner' ? `anel${s1.ringKm} pool determinístico` : s1.kind,
    );

    await client.query('ROLLBACK');

    console.log(`\n${fails === 0 ? '✅ TODOS OS CASOS DA PROXIMIDADE PASSARAM' : `❌ ${fails} CASO(S) FALHARAM`}`);
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
