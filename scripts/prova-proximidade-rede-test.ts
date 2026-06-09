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
 *
 * Casos da FASE 3 (ENTREGA pelo raio — delivery_radius_km):
 *   5. Ninguém com raio preenchido → ENTREGA vai pra matriz (mesmo com loja colada
 *      com estoque): quem não declarou raio está FORA da entrega.
 *   6. Raio cobre a distância (Caxias ~8 km, raio 10) → prox-madureira entrega
 *      (muro caiu TAMBÉM na entrega).
 *   7. Raio NÃO cobre (raio 5 < ~8 km) → matriz (o raio é o consentimento da loja).
 *   8. Retirada IGNORA o raio: raio apertado (1 km) não tira a loja da retirada.
 *   9. Busca = pedido: resolveProductAvailabilityByProximity segue a MESMA régua
 *      (sem raio → não promete; com raio que cobre → mostra a loja).
 */

// Flags ANTES dos imports (env parseia no load). NÃO mexe no .env global.
process.env.ROUTING_PROXIMITY_FIRST = 'true';
process.env.ROUTING_GEO_ROAD_DISTANCE = 'false';

const { pool } = await import('../src/persistence/db.js');
const {
  decideStoreForItemsGeo,
  resolveProductAvailabilityByProximity,
  resolveUnitCandidates,
  resolveUnitCandidatesByProximity,
} = await import('../src/atendente-v2/fulfillment.js');
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

    const decide = (loc: { lat: number; lng: number }, modalidade: 'delivery' | 'pickup' = 'pickup') =>
      decideStoreForItemsGeo(client, ENV, {
        municipio: 'duque de caxias', // proximidade ignora o município; só satisfaz a assinatura
        items,
        modalidade,
        customerLocation: loc,
        clientNeighborhoodCanonical: null,
      });
    // Fase 3 — manipulação do raio DECLARADO (delivery_radius_km) dentro da transação.
    const setRadius = (slug: string, km: number | null) =>
      client.query(`UPDATE network.partner_units SET delivery_radius_km=$3 WHERE environment=$1 AND slug=$2`, [ENV, slug, km]);
    const clearAllRadius = () =>
      client.query(`UPDATE network.partner_units SET delivery_radius_km=NULL WHERE environment=$1`, [ENV]);

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

    // ── FASE 3: ENTREGA pelo raio (delivery_radius_km) ──────────────────────
    await client.query('BEGIN');
    await clearAllRadius(); // estado conhecido: NINGUÉM declarou raio (tudo NULL)

    // 5 — ninguém com raio → a ENTREGA cai na matriz, mesmo com loja colada com estoque.
    const e5 = await decide(CAXIAS, 'delivery');
    check('5 entrega sem raio declarado → matriz (silêncio ≠ consentimento)', e5.kind === 'matriz', e5.kind);

    // 6 — raio cobre a distância (~8 km ≤ 10) → prox-madureira ENTREGA pra Caxias
    //     (o muro da cidade caiu TAMBÉM na entrega; geo-madureira sem raio fica fora).
    await setRadius('prox-madureira', 10);
    const e6 = await decide(CAXIAS, 'delivery');
    check(
      '6 raio 10 km cobre ~8 km: prox-madureira entrega pra Caxias (muro caiu na entrega)',
      e6.kind === 'partner' && e6.routing.unitId === U['prox-madureira'] && e6.distanceKm <= 10,
      e6.kind === 'partner' ? `@${Math.round(e6.distanceKm)}km anel${e6.ringKm}` : e6.kind,
    );

    // 7 — raio 5 NÃO cobre ~8 km → matriz (o raio é o consentimento do borracheiro).
    await setRadius('prox-madureira', 5);
    const e7 = await decide(CAXIAS, 'delivery');
    check('7 raio 5 km não cobre ~8 km → matriz (dist > raio declarado)', e7.kind === 'matriz', e7.kind);

    // 8 — retirada IGNORA o raio: mesmo com raio apertado, a retirada continua igual.
    const e8 = await decide(CAXIAS, 'pickup');
    check(
      '8 retirada ignora o raio (o cliente é quem vai à loja)',
      e8.kind === 'partner' && madureiraIds.has(e8.routing.unitId),
      e8.kind === 'partner' ? `@${Math.round(e8.distanceKm)}km anel${e8.ringKm}` : e8.kind,
    );

    // 9 — BUSCA segue a MESMA régua do pedido (a fala e o registro nunca divergem).
    await clearAllRadius();
    const busca = () =>
      resolveProductAvailabilityByProximity(client, ENV, {
        municipio: 'duque de caxias',
        customerLocation: CAXIAS,
        clientNeighborhoodCanonical: null,
        productIds: [productId],
      });
    const b1 = await busca();
    check('9a busca sem raio: não promete loja perto (mantém o backstop da matriz)', !b1.has(productId), `${b1.size} produto(s) no mapa`);
    await setRadius('prox-madureira', 10);
    const b2 = await busca();
    check(
      '9b busca com raio que cobre: mostra a MESMA loja que o pedido escolheria',
      b2.get(productId)?.unitId === U['prox-madureira'],
      b2.get(productId) ? `unit=${b2.get(productId)!.unitId.slice(0, 8)} qtd=${b2.get(productId)!.available}` : 'mapa vazio',
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
