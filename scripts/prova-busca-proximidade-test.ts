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
import { resolveProductAvailabilityByProximity, resolveUnitCandidates, getUnitMapsUrl, decideStoreForItemsGeo } from '../src/atendente-v2/fulfillment.js';
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
    // localizacao_loja (getUnitMapsUrl) com product_ids → nome da loja que TEM o pneu
    const loja1 = await getUnitMapsUrl(client, ENV, { municipio: MUNICIPIO, customerLocation: IRAJA, productIds: [PRODUTO] });
    check('1.localizacao_loja indica a MAIS PERTO que tem', loja1?.nome_loja === maisPerto.nome, `${loja1?.nome_loja} esperado ${maisPerto.nome}`);

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
    // localizacao_loja: o NOME indicado pro cliente NÃO pode ser a loja apagada (o furo do transcript)
    const loja2 = await getUnitMapsUrl(client, ENV, { municipio: MUNICIPIO, customerLocation: IRAJA, productIds: [PRODUTO] });
    check('2.localizacao_loja NÃO indica a loja apagada', loja2?.nome_loja !== maisPerto.nome, `indicou ${loja2?.nome_loja}`);
    check('2.localizacao_loja indica a 2ª mais perto (que tem)', loja2?.nome_loja === segunda.nome, `${loja2?.nome_loja} esperado ${segunda.nome}`);

    // ── 2b) RETIRADA (pickup, raio 15 km): com Madureira apagada, o pedido de retirada
    //        cai numa loja DENTRO de 15 km que tem (Méier/Tijuca), nunca na apagada. ──
    const within15 = new Set(inRange.filter((e) => e.km <= 15).map((e) => e.unitId));
    const pick2 = await decideStoreForItemsGeo(client, ENV, {
      municipio: MUNICIPIO, items: [{ product_id: PRODUTO, quantity: 1 }],
      modalidade: 'pickup', customerLocation: IRAJA, clientNeighborhoodCanonical: null,
    });
    check('2b.retirada cai numa loja (partner) dentro do raio', pick2.kind === 'partner', `kind=${pick2.kind}`);
    check('2b.retirada NÃO é a apagada e está dentro de 15km', pick2.kind === 'partner' && pick2.routing.unitId !== maisPerto.unitId && within15.has(pick2.routing.unitId), `unit=${pick2.kind === 'partner' ? pick2.routing.unitId : '-'}`);

    // ── 2c) apaga TODAS as lojas dentro de 15 km → a que tem fica FORA do raio →
    //        retirada devolve 'only_far' (respeita o limite de 15 km, não retira longe calado). ──
    await client.query(
      `UPDATE commerce.partner_stock_levels SET deleted_at = now()
       WHERE environment = $1 AND unit_id = ANY($2) AND product_id = $3`,
      [ENV, [...within15], PRODUTO],
    );
    const pick3 = await decideStoreForItemsGeo(client, ENV, {
      municipio: MUNICIPIO, items: [{ product_id: PRODUTO, quantity: 1 }],
      modalidade: 'pickup', customerLocation: IRAJA, clientNeighborhoodCanonical: null,
    });
    check('2c.só tem fora de 15km → retirada = only_far (respeita o limite de 15km)', pick3.kind === 'only_far', `kind=${pick3.kind}`);

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
    // localizacao_loja: nenhuma loja perto tem → null (bot não chuta loja; responde honesto)
    const loja3 = await getUnitMapsUrl(client, ENV, { municipio: MUNICIPIO, customerLocation: IRAJA, productIds: [PRODUTO] });
    check('3.localizacao_loja não indica loja (null) quando ninguém tem', loja3 === null, JSON.stringify(loja3));
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
