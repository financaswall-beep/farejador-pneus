/**
 * PROVA da camada GEO (proximidade) no env `test`, chamando o CÓDIGO REAL
 * (decideStoreForItemsGeo) com a coordenada do cliente. Tudo em BEGIN/ROLLBACK —
 * não persiste nada. Usa distância em LINHA RETA (haversine): NÃO ligue
 * ROUTING_GEO_ROAD_DISTANCE nem GOOGLE_MAPS_API_KEY (determinismo, sem rede).
 *
 * Pré-requisito: scripts/seed-fake-rede-test.cjs já rodado (cria os geo-*).
 *
 * USO:
 *   npx tsx --env-file=.env scripts/prova-geo-rede-test.ts
 *
 * Cliente fixo em COPACABANA. Casos: A feliz (anel 10) · I justiça entre os perto
 * (não a mais colada) · B expande (10→20) · C retirada 15km (sem filtro de bairro)
 * · D bairro não declarado (4a) · E só tem longe (honestidade) · determinismo.
 */
import { pool } from '../src/persistence/db.js';
import { decideStoreForItemsGeo } from '../src/atendente-v2/fulfillment.js';
import { env } from '../src/shared/config/env.js';

const ENV = 'test' as const;
const GEO_MUNI = 'zona-sul-geo';
const COPA = { lat: -22.984613, lng: -43.198278 };
const SLUGS = ['geo-leme', 'geo-tijuca', 'geo-meier', 'geo-niteroi', 'geo-madureira', 'geo-barra', 'geo-itaborai', 'geo-bairro'];

async function main(): Promise<void> {
  if (env.FAREJADOR_ENV !== 'test') throw new Error('ABORTADO: só roda em test.');
  console.log('=== PROVA GEO REDE (test) ===');
  if (env.ROUTING_GEO_ROAD_DISTANCE) {
    console.log('⚠️  ROUTING_GEO_ROAD_DISTANCE on — a prova espera haversine; desligue p/ determinismo.');
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
    if (ids.rowCount !== SLUGS.length) throw new Error(`esperava ${SLUGS.length} geo-fake, achei ${ids.rowCount}. Rode o seed.`);
    const U: Record<string, string> = Object.fromEntries(ids.rows.map((r) => [r.slug, r.unit_id]));
    const slugOf = (unitId: string): string => Object.keys(U).find((s) => U[s] === unitId) ?? unitId.slice(0, 8);

    const prod = await client.query<{ id: string }>(
      `SELECT id FROM commerce.products WHERE environment=$1 AND product_code=$2`,
      [ENV, 'FAKE-REDE-PNEU'],
    );
    const productId = prod.rows[0]!.id;
    const items = [{ product_id: productId, quantity: 1 }];

    const decide = (modalidade: 'delivery' | 'pickup', bairro: string | null) =>
      decideStoreForItemsGeo(client, ENV, {
        municipio: GEO_MUNI,
        items,
        modalidade,
        customerLocation: COPA,
        clientNeighborhoodCanonical: bairro,
      });
    const addLead = (unitId: string) =>
      client.query(`INSERT INTO commerce.partner_orders (environment, unit_id, total_amount, source_tag) VALUES ($1,$2,200,'2w')`, [ENV, unitId]);
    const zera = (...slugs: string[]) =>
      client.query(
        `UPDATE commerce.partner_stock_levels SET quantity_on_hand=0, stock_status='out_of_stock' WHERE environment=$1 AND unit_id = ANY($2)`,
        [ENV, slugs.map((s) => U[s]!)],
      );

    // ── A + I + B no mesmo BEGIN ──────────────────────────────────────────────
    await client.query('BEGIN');

    // A — feliz (entrega): todos com estoque. 4a tira geo-bairro (cobre só 'tijuca').
    // anel 10 = {geo-leme ~4km, geo-tijuca ~7km} → a justiça escolhe entre os dois.
    const A = await decide('delivery', 'copacabana');
    check(
      'A feliz: anel 10 km, pool={leme,tijuca}',
      A.kind === 'partner' && A.ringKm === 10 && ['geo-leme', 'geo-tijuca'].includes(slugOf(A.routing.unitId)),
      A.kind === 'partner' ? `${slugOf(A.routing.unitId)} @${Math.round(A.distanceKm)}km anel${A.ringKm}` : A.kind,
    );

    // I — justiça (não a mais colada): dá um lead pro vencedor → a vez vira do outro.
    if (A.kind === 'partner') {
      await addLead(A.routing.unitId);
      const A2 = await decide('delivery', 'copacabana');
      check(
        'I justiça entre os perto: troca após lead (não fixa na mais colada)',
        A2.kind === 'partner' && slugOf(A2.routing.unitId) !== slugOf(A.routing.unitId),
        A2.kind === 'partner' ? `${slugOf(A.routing.unitId)}→${slugOf(A2.routing.unitId)}` : A2.kind,
      );
    }

    // B — expande o anel (10→20): zera os ≤10 → anel 10 vazio → anel 20 = {meier,niteroi,madureira}.
    await zera('geo-leme', 'geo-tijuca', 'geo-bairro');
    const B = await decide('delivery', 'copacabana');
    check(
      'B expande: anel 20 km quando ninguém ≤10 tem',
      B.kind === 'partner' && B.ringKm === 20 && ['geo-meier', 'geo-niteroi', 'geo-madureira'].includes(slugOf(B.routing.unitId)),
      B.kind === 'partner' ? `${slugOf(B.routing.unitId)} @${Math.round(B.distanceKm)}km anel${B.ringKm}` : B.kind,
    );
    await client.query('ROLLBACK');

    // C — retirada em FAIXAS [5,10,15] (ignora cobertura de bairro): a banda MAIS PERTO ganha.
    // geo-leme ~4km cai na faixa 5 e é o único nela → ganha direto (não revezа com os de 7-13km).
    // geo-bairro é delivery-only → fora de qualquer forma. (Antes era anel único de 15km; virou
    // faixas em c31e436 — esta prova estava defasada nessa mudança.)
    await client.query('BEGIN');
    const C = await decide('pickup', 'copacabana');
    check(
      'C retirada: faixas [5,10,15], banda mais perto ganha (geo-leme @~4km → anel 5)',
      C.kind === 'partner' && C.ringKm === 5 && slugOf(C.routing.unitId) === 'geo-leme',
      C.kind === 'partner' ? `${slugOf(C.routing.unitId)} @${Math.round(C.distanceKm)}km anel${C.ringKm}` : C.kind,
    );
    await client.query('ROLLBACK');

    // D — bairro não declarado (entrega, 4a): só geo-bairro com estoque (cobre só 'tijuca').
    await client.query('BEGIN');
    await zera('geo-leme', 'geo-tijuca', 'geo-meier', 'geo-niteroi', 'geo-madureira', 'geo-barra', 'geo-itaborai');
    const Dcopa = await decide('delivery', 'copacabana');
    check('D bairro NÃO declarado (copa): 4a exclui mesmo coladinho → matriz', Dcopa.kind === 'matriz', Dcopa.kind);
    const Dtijuca = await decide('delivery', 'tijuca');
    check(
      'D bairro declarado (tijuca): entra → geo-bairro',
      Dtijuca.kind === 'partner' && slugOf(Dtijuca.routing.unitId) === 'geo-bairro',
      Dtijuca.kind === 'partner' ? slugOf(Dtijuca.routing.unitId) : Dtijuca.kind,
    );
    await client.query('ROLLBACK');

    // E — só tem LONGE (honestidade): só geo-itaborai (~44km) com estoque → only_far.
    await client.query('BEGIN');
    await zera('geo-leme', 'geo-tijuca', 'geo-meier', 'geo-niteroi', 'geo-madureira', 'geo-barra', 'geo-bairro');
    const E = await decide('delivery', 'copacabana');
    check(
      'E só tem longe → only_far (geo-itaborai ~44km, além do anel)',
      E.kind === 'only_far' && E.unitName.toUpperCase().includes('ITABORAI') && E.distanceKm > 30,
      E.kind === 'only_far' ? `${Math.round(E.distanceKm)}km ${E.unitName}` : E.kind,
    );
    // E2 — consentimento: o only_far CARREGA a rota da loja mais perto dos longes (geo-itaborai)
    // com o item completo, pronta pra reservar SE o cliente bancar ir buscar. Sem isso o
    // criar_pedido não teria como materializar o pedido longe.
    check(
      'E2 only_far carrega a rota pronta (consentimento) → geo-itaborai + item',
      E.kind === 'only_far' &&
        slugOf(E.routing.unitId) === 'geo-itaborai' &&
        E.routing.items.length === 1 &&
        E.routing.items[0]!.product_id === productId &&
        !!E.routing.items[0]!.partner_stock_id,
      E.kind === 'only_far' ? `${slugOf(E.routing.unitId)} itens=${E.routing.items.length}` : E.kind,
    );
    await client.query('ROLLBACK');

    // determinismo: mesma entrada → mesma loja.
    await client.query('BEGIN');
    const z1 = await decide('delivery', 'copacabana');
    const z2 = await decide('delivery', 'copacabana');
    check(
      'determinismo: 2x → mesma loja',
      z1.kind === 'partner' && z2.kind === 'partner' && z1.routing.unitId === z2.routing.unitId,
      z1.kind === 'partner' ? slugOf(z1.routing.unitId) : z1.kind,
    );
    await client.query('ROLLBACK');

    console.log(`\n${fails === 0 ? '✅ TODOS OS CASOS GEO PASSARAM' : `❌ ${fails} CASO(S) FALHARAM`}`);
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
