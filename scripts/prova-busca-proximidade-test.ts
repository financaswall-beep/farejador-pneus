/**
 * PROVA — a BUSCA (buscar_produto) reflete a loja que VAI atender, por proximidade.
 *
 * Caso do Wallace (2026-06-08): cliente em Irajá pergunta do 90/90-18. Se a loja
 * mais perto (Madureira) NÃO tem, a busca tem que ANDAR pra próxima loja mais perto
 * que tem (Méier, …) até 40 km; se NENHUMA em alcance tem, cai na matriz (backstop).
 *
 * Roda em transação BEGIN/ROLLBACK contra o banco REAL (env=prod) — zera estoque
 * DENTRO da transação e desfaz tudo no fim. Determinístico (haversine): NÃO ligue
 * ROUTING_GEO_ROAD_DISTANCE.
 *
 *   npx tsx --env-file=.env scripts/prova-busca-proximidade-test.ts
 */
import { pool } from '../src/persistence/db.js';
import { resolveProductAvailabilityByProximity, resolveUnitCandidates } from '../src/atendente-v2/fulfillment.js';
import { filterByModeAndCoverage } from '../src/atendente-v2/geo-routing.js';
import { haversineKm } from '../src/shared/geo/haversine.js';
import { env } from '../src/shared/config/env.js';

const ENV = 'prod' as const;
const PRODUTO = '803a4169-45e6-4233-a6ac-01212497c0cb'; // Pneu Moto 90/90-18 Traseiro
const MUNICIPIO = 'Rio de Janeiro';
const IRAJA = { lat: -22.8311, lng: -43.3289 }; // bairro de Irajá, Zona Norte/RJ

let falhas = 0;
function check(nome: string, cond: boolean, detalhe = ''): void {
  console.log(`${cond ? '✅' : '❌'} ${nome}${detalhe ? '  →  ' + detalhe : ''}`);
  if (!cond) falhas++;
}

async function main(): Promise<void> {
  if (env.ROUTING_GEO_ROAD_DISTANCE) {
    console.log('⚠️  ROUTING_GEO_ROAD_DISTANCE on — a prova espera haversine; desligue p/ determinismo.');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── lojas elegíveis (entrega) que cobrem o Rio, da mais perto de Irajá pra longe ──
    const candidates = await resolveUnitCandidates(client, ENV, MUNICIPIO);
    const servable = new Set(
      filterByModeAndCoverage(
        candidates.map((c) => ({
          unitId: c.ctx.unitId,
          serviceMode: c.serviceMode,
          location: c.location,
          hasCityCoverage: c.hasCityCoverage,
          neighborhoods: c.neighborhoods,
        })),
        'delivery',
        null,
      ).map((c) => c.unitId),
    );
    const eligible = candidates
      .filter((c) => servable.has(c.ctx.unitId) && c.location != null)
      .map((c) => ({ unitId: c.ctx.unitId, nome: c.ctx.unitName, km: haversineKm(IRAJA, c.location!) }))
      .sort((a, b) => a.km - b.km);
    const inRange = eligible.filter((e) => e.km <= 40);

    console.log('\n=== lojas que atendem ENTREGA no Rio, distância de Irajá (≤40 km entram) ===');
    for (const e of eligible) console.log(`  ${e.km <= 40 ? '•' : '×'} ${e.nome.padEnd(26)} ${e.km.toFixed(1)} km  ${e.unitId}`);

    if (inRange.length < 2) {
      console.log('\n⚠️  Menos de 2 lojas em alcance com o produto — não dá pra provar o "andar pra próxima". Abortando.');
      check('pré-requisito: ≥2 lojas em alcance', false);
      return;
    }
    const maisPerto = inRange[0]!;
    const segunda = inRange[1]!;

    // normaliza DENTRO da transação: restaura qualquer linha em alcance que esteja
    // soft-deleted (a Madureira está apagada no prod agora) → baseline determinístico.
    await client.query(
      `UPDATE commerce.partner_stock_levels SET deleted_at = NULL
       WHERE environment = $1 AND unit_id = ANY($2) AND product_id = $3 AND deleted_at IS NOT NULL`,
      [ENV, inRange.map((e) => e.unitId), PRODUTO],
    );

    // ── 1) BASELINE: a busca devolve a loja MAIS PERTO que tem ──
    const a1 = await resolveProductAvailabilityByProximity(client, ENV, {
      municipio: MUNICIPIO, customerLocation: IRAJA, clientNeighborhoodCanonical: null, productIds: [PRODUTO],
    });
    check('1.baseline: achou o produto numa loja', a1.has(PRODUTO), JSON.stringify(a1.get(PRODUTO)));
    check('1.baseline: é a loja MAIS PERTO', a1.get(PRODUTO)?.unitId === maisPerto.unitId, `${a1.get(PRODUTO)?.unitId} esperado ${maisPerto.nome}`);

    // ── 2) APAGA a MAIS PERTO pelo PAINEL (soft-delete = deleted_at) → busca anda pra a
    //       2ª mais perto. Reproduz EXATO o caso do Wallace: ele apagou pelo painel da
    //       Madureira (deleted_at marcado, quantity_on_hand fica 10) e o bot ia pra lá. ──
    await client.query(
      `UPDATE commerce.partner_stock_levels SET deleted_at = now()
       WHERE environment = $1 AND unit_id = $2 AND product_id = $3`,
      [ENV, maisPerto.unitId, PRODUTO],
    );
    const a2 = await resolveProductAvailabilityByProximity(client, ENV, {
      municipio: MUNICIPIO, customerLocation: IRAJA, clientNeighborhoodCanonical: null, productIds: [PRODUTO],
    });
    check('2.com a mais perto APAGADA no painel: ainda acha o produto', a2.has(PRODUTO), JSON.stringify(a2.get(PRODUTO)));
    check('2.NÃO indica mais a loja apagada (respeita deleted_at)', a2.get(PRODUTO)?.unitId !== maisPerto.unitId, `indicou ${a2.get(PRODUTO)?.unitId}`);
    check('2.andou pra a 2ª mais perto', a2.get(PRODUTO)?.unitId === segunda.unitId, `${a2.get(PRODUTO)?.unitId} esperado ${segunda.nome}`);

    // ── 3) APAGA TODAS em alcance → cai na matriz (função não devolve nada p/ o produto) ──
    await client.query(
      `UPDATE commerce.partner_stock_levels SET deleted_at = now()
       WHERE environment = $1 AND unit_id = ANY($2) AND product_id = $3`,
      [ENV, inRange.map((e) => e.unitId), PRODUTO],
    );
    const a3 = await resolveProductAvailabilityByProximity(client, ENV, {
      municipio: MUNICIPIO, customerLocation: IRAJA, clientNeighborhoodCanonical: null, productIds: [PRODUTO],
    });
    check('3.TODAS em alcance zeradas: nenhuma loja → cai na matriz (sem override)', !a3.has(PRODUTO), JSON.stringify([...a3]));
  } catch (e) {
    console.error('\nERRO NA PROVA:', e instanceof Error ? e.stack : e);
    falhas++;
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
  console.log(`\n=== ${falhas === 0 ? 'TUDO VERDE ✅ — a busca anda pela proximidade e respeita o estoque real' : falhas + ' FALHA(S) ❌'} ===`);
  process.exit(falhas === 0 ? 0 : 1);
}

void main();
