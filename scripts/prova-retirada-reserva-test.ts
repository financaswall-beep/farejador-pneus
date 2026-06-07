/**
 * PROVA da RETIRADA RESERVADA (PICKUP_TO_PARTNER) no env `test`, chamando o CÓDIGO
 * REAL (decideStoreForItemsGeo + materializePartnerOrder). Tudo em BEGIN/ROLLBACK —
 * não persiste nada. Distância em LINHA RETA (haversine): não ligue
 * ROUTING_GEO_ROAD_DISTANCE / GOOGLE_MAPS_API_KEY (determinismo).
 *
 * Pré-requisito: scripts/seed-fake-rede-test.cjs já rodado (cria os geo-*).
 *
 * USO:
 *   npx tsx --env-file=.env scripts/prova-retirada-reserva-test.ts
 *
 * Prova:
 *   1) retirada ESCOLHE a loja por proximidade (anel de retirada ≤15km) — igual à entrega;
 *   2) materializa com reserva → estoque RESERVADO (+1 reservado), on_hand INTACTO;
 *   3) pedido cai como RETIRADA no painel do parceiro (fulfillment_mode=pickup, 2w);
 *   4) ZERO recebível (dinheiro só entra no "marcar retirado");
 *   5) invariante: balcão (reserve_for_pickup=false) AINDA baixa o estoque.
 */
import { pool } from '../src/persistence/db.js';
import { decideStoreForItemsGeo, materializePartnerOrder } from '../src/atendente-v2/fulfillment.js';
import { env } from '../src/shared/config/env.js';

const ENV = 'test' as const;
const GEO_MUNI = 'zona-sul-geo';
const COPA = { lat: -22.984613, lng: -43.198278 };

async function main(): Promise<void> {
  if (env.FAREJADOR_ENV !== 'test') throw new Error('ABORTADO: só roda em test.');
  console.log('=== PROVA RETIRADA RESERVADA (test) ===');
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
    const prod = await client.query<{ id: string }>(
      `SELECT id FROM commerce.products WHERE environment=$1 AND product_code=$2`,
      [ENV, 'FAKE-REDE-PNEU'],
    );
    if (prod.rowCount === 0) throw new Error('produto FAKE-REDE-PNEU não existe no test. Rode o seed.');
    const productId = prod.rows[0]!.id;
    const items = [{ product_id: productId, quantity: 1 }];

    // ── CASE 1: retirada com reserva (a feature) ──────────────────────────────
    await client.query('BEGIN');
    const geo = await decideStoreForItemsGeo(client, ENV, {
      municipio: GEO_MUNI,
      items,
      modalidade: 'pickup',
      customerLocation: COPA,
      clientNeighborhoodCanonical: 'copacabana',
    });
    check(
      '1) retirada escolhe loja por PROXIMIDADE (anel ≤15km)',
      geo.kind === 'partner' && (geo.ringKm ?? 99) <= 15,
      geo.kind === 'partner' ? `${geo.routing.ctx.unitName} @${Math.round(geo.distanceKm)}km anel${geo.ringKm}` : geo.kind,
    );

    if (geo.kind === 'partner') {
      const stockId = geo.routing.items[0]!.partner_stock_id;
      const before = await client.query<{ on_hand: number; reserved: number }>(
        `SELECT quantity_on_hand AS on_hand, COALESCE(quantity_reserved,0) AS reserved
         FROM commerce.partner_stock_levels WHERE id=$1`,
        [stockId],
      );
      const b = before.rows[0]!;

      const mat = await materializePartnerOrder(client, geo.routing.ctx, {
        customer_name: 'Cliente Retirada Teste',
        customer_phone: null,
        items: geo.routing.items.map((it) => ({
          partner_stock_id: it.partner_stock_id,
          quantity: it.quantity,
          unit_price: it.central_price,
        })),
        fulfillment_mode: 'pickup',
        delivery_address: null,
        freight_amount: 0,
        idempotency_key: `prova-retirada-${Date.now()}`,
        reserve_for_pickup: true,
      });

      const after = await client.query<{ on_hand: number; reserved: number }>(
        `SELECT quantity_on_hand AS on_hand, COALESCE(quantity_reserved,0) AS reserved
         FROM commerce.partner_stock_levels WHERE id=$1`,
        [stockId],
      );
      const a = after.rows[0]!;
      check('2) estoque RESERVADO (+1 reservado)', Number(a.reserved) === Number(b.reserved) + 1, `reserved ${b.reserved}→${a.reserved}`);
      check('2) estoque NÃO baixado (on_hand intacto)', Number(a.on_hand) === Number(b.on_hand), `on_hand ${b.on_hand}→${a.on_hand}`);

      const po = await client.query<{ fulfillment_mode: string; source_tag: string; status: string }>(
        `SELECT fulfillment_mode, source_tag, status FROM commerce.partner_orders WHERE id=$1`,
        [mat.partner_order_id],
      );
      check(
        '3) pedido é RETIRADA no painel do parceiro (2w)',
        po.rows[0]?.fulfillment_mode === 'pickup' && po.rows[0]?.source_tag === '2w',
        JSON.stringify(po.rows[0]),
      );

      const rec = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM finance.partner_receivables WHERE source_order_id=$1`,
        [mat.partner_order_id],
      );
      check('4) SEM recebível (dinheiro só no "marcar retirado")', Number(rec.rows[0]!.n) === 0, `recebíveis=${rec.rows[0]!.n}`);
    }
    await client.query('ROLLBACK');

    // ── CASE 2: invariante — balcão (reserve_for_pickup=false) AINDA baixa ─────
    await client.query('BEGIN');
    const su = await client.query<{ stock_id: string; unit_id: string; on_hand: number }>(
      `SELECT psl.id AS stock_id, psl.unit_id, psl.quantity_on_hand AS on_hand
       FROM commerce.partner_stock_levels psl
       JOIN network.partner_units pu ON pu.unit_id=psl.unit_id AND pu.environment=psl.environment
       WHERE psl.environment=$1 AND psl.product_id=$2 AND psl.is_tracked AND psl.quantity_on_hand>0
       ORDER BY pu.slug LIMIT 1`,
      [ENV, productId],
    );
    const s = su.rows[0]!;
    await client.query(
      `SELECT commerce.register_partner_local_order($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        ENV, s.unit_id, 'Balcao Teste', null,
        JSON.stringify([{ partner_stock_id: s.stock_id, quantity: 1, unit_price: 100 }]),
        'dinheiro', 'pickup', null, 'prova:balcao', `prova-balcao-${Date.now()}`, 'porta', 0, 0, false,
      ],
    );
    const afterB = await client.query<{ on_hand: number }>(
      `SELECT quantity_on_hand AS on_hand FROM commerce.partner_stock_levels WHERE id=$1`,
      [s.stock_id],
    );
    check(
      '5) invariante: balcão (reserve=false) AINDA baixa o estoque',
      Number(afterB.rows[0]!.on_hand) === Number(s.on_hand) - 1,
      `on_hand ${s.on_hand}→${afterB.rows[0]!.on_hand}`,
    );
    await client.query('ROLLBACK');

    const reservePickup = async (idem: string, name: string) => {
      const geo = await decideStoreForItemsGeo(client, ENV, {
        municipio: GEO_MUNI, items, modalidade: 'pickup', customerLocation: COPA, clientNeighborhoodCanonical: 'copacabana',
      });
      if (geo.kind !== 'partner') return null;
      const stockId = geo.routing.items[0]!.partner_stock_id;
      const before = (await client.query<{ on_hand: number; reserved: number }>(
        `SELECT quantity_on_hand AS on_hand, COALESCE(quantity_reserved,0) AS reserved FROM commerce.partner_stock_levels WHERE id=$1`, [stockId])).rows[0]!;
      const mat = await materializePartnerOrder(client, geo.routing.ctx, {
        customer_name: name, customer_phone: null,
        items: geo.routing.items.map((it) => ({ partner_stock_id: it.partner_stock_id, quantity: it.quantity, unit_price: it.central_price })),
        fulfillment_mode: 'pickup', delivery_address: null, freight_amount: 0, idempotency_key: idem, reserve_for_pickup: true,
      });
      return { ctx: geo.routing.ctx, orderId: mat.partner_order_id, total: mat.total_amount, stockId, before };
    };
    const snap = async (stockId: string) => (await client.query<{ on_hand: number; reserved: number }>(
      `SELECT quantity_on_hand AS on_hand, COALESCE(quantity_reserved,0) AS reserved FROM commerce.partner_stock_levels WHERE id=$1`, [stockId])).rows[0]!;

    // ── CASE 3: marcar retirado → baixa + libera reserva + caixa ──────────────
    await client.query('BEGIN');
    const r3 = await reservePickup(`prova-c3-${Date.now()}`, 'Retira C3');
    if (!r3) { check('3) setup retirar', false); } else {
      await client.query('SELECT commerce.complete_partner_pickup($1,$2)', [r3.orderId, 'partner:geo-test']);
      await client.query(`UPDATE commerce.partner_orders SET awaiting_pickup=false, retrieved_at=now(), status='paid' WHERE id=$1`, [r3.orderId]);
      await client.query(
        `INSERT INTO finance.partner_receivables (environment, unit_id, customer_id, customer_name, description, source_tag, amount, due_date, status, received_at, payment_method, notes, created_by, idempotency_key, source_order_id)
         VALUES ($1,$2,NULL,$3,$4,'2w',$5,NULL,'received',now(),'dinheiro',$6,'partner:geo-test',$7,$8)`,
        [ENV, r3.ctx.unitId, 'Retira C3', `Retirada ${r3.orderId.slice(0,8)}`, r3.total, 'teste retirada', `order:${r3.orderId}:pickup-receivable`, r3.orderId]);
      const a = await snap(r3.stockId);
      check('3) retirar: estoque BAIXOU 1 (reserva→venda)', Number(a.on_hand) === Number(r3.before.on_hand) - 1, `on_hand ${r3.before.on_hand}→${a.on_hand}`);
      check('3) retirar: reserva LIBERADA (volta ao original)', Number(a.reserved) === Number(r3.before.reserved), `reserved ${r3.before.reserved}→${a.reserved}`);
      const po = (await client.query<{ awaiting_pickup: boolean; status: string; retrieved_at: string | null }>(
        `SELECT awaiting_pickup, status, retrieved_at FROM commerce.partner_orders WHERE id=$1`, [r3.orderId])).rows[0]!;
      check('3) retirar: pago + não-aguardando + retrieved_at', po.awaiting_pickup === false && po.status === 'paid' && po.retrieved_at != null, JSON.stringify(po));
      const cash = (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM finance.partner_receivables WHERE source_order_id=$1 AND status='received'`, [r3.orderId])).rows[0]!;
      check('3) retirar: caixa lançado (1 recebível recebido)', Number(cash.n) === 1, `recebidos=${cash.n}`);
    }
    await client.query('ROLLBACK');

    // ── CASE 4: cancelar reservada → libera reserva, NÃO infla on_hand ────────
    await client.query('BEGIN');
    const r4 = await reservePickup(`prova-c4-${Date.now()}`, 'Cancela C4');
    if (!r4) { check('4) setup cancelar', false); } else {
      await client.query('SELECT commerce.cancel_partner_local_order($1,$2,$3)', [r4.orderId, 'partner:geo-test', 'cliente nao apareceu']);
      const a = await snap(r4.stockId);
      const st = (await client.query<{ status: string }>(`SELECT status FROM commerce.partner_orders WHERE id=$1`, [r4.orderId])).rows[0]!;
      check('4) cancelar: reserva LIBERADA (volta ao original)', Number(a.reserved) === Number(r4.before.reserved), `reserved ${r4.before.reserved}→${a.reserved}`);
      check('4) cancelar: on_hand INTACTO (não inflou)', Number(a.on_hand) === Number(r4.before.on_hand), `on_hand ${r4.before.on_hand}→${a.on_hand}`);
      check('4) cancelar: pedido cancelado', st.status === 'cancelled', st.status);
    }
    await client.query('ROLLBACK');

    // ── CASE 5: origem (source_tag) IMUTÁVEL (anti-trapaça 2w) ────────────────
    await client.query('BEGIN');
    const r5 = await reservePickup(`prova-c5-${Date.now()}`, 'Imut C5');
    if (!r5) { check('5) setup imutavel', false); } else {
      let blocked = false;
      try {
        await client.query(`UPDATE commerce.partner_orders SET source_tag='porta' WHERE id=$1`, [r5.orderId]);
      } catch { blocked = true; }
      check('5) origem 2w IMUTÁVEL (trocar p/ porta é bloqueado)', blocked, blocked ? 'bloqueado ✓' : 'PASSOU (FURO!)');
    }
    await client.query('ROLLBACK');

    console.log(`\n${fails === 0 ? '✅ RETIRADA RESERVADA: TODOS OS CASOS PASSARAM' : `❌ ${fails} CASO(S) FALHARAM`}`);
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
