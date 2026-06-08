/**
 * PROVA da mudança "ENTREGA só vira dinheiro QUANDO ENTREGUE" (Wallace 2026-06-08),
 * no env `test`, chamando o CÓDIGO REAL (decideStoreForItemsGeo + materializePartnerOrder).
 * Tudo em BEGIN/ROLLBACK — não persiste nada. Haversine (não ligue ROAD_DISTANCE).
 *
 * Pré-requisito: scripts/seed-fake-rede-test.cjs já rodado.
 *
 * USO:
 *   npx tsx --env-file=.env scripts/prova-entrega-recebivel-test.ts
 *
 * Prova:
 *   1) entrega do bot (COD) NÃO abre conta a receber no nascimento (a mudança);
 *   2) "marcar entregue" (deliver + INSERT received, idêntico ao handler) → baixa o
 *      estoque + cria 1 recebível JÁ 'received' (caixa entra só aqui);
 *   3) "não entregue" (cancel) → libera reserva, segue SEM recebível, pedido cancelado;
 *   4) regressão: retirada continua SEM recebível no nascimento (inalterada).
 */
import { pool } from '../src/persistence/db.js';
import { decideStoreForItemsGeo, materializePartnerOrder } from '../src/atendente-v2/fulfillment.js';
import { env } from '../src/shared/config/env.js';

const ENV = 'test' as const;
const GEO_MUNI = 'zona-sul-geo';
const COPA = { lat: -22.984613, lng: -43.198278 };

async function main(): Promise<void> {
  if (env.FAREJADOR_ENV !== 'test') throw new Error('ABORTADO: só roda em test.');
  console.log('=== PROVA ENTREGA = DINHEIRO SÓ NA ENTREGA (test) ===');
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

    // helper: cria pedido de ENTREGA (COD) do bot via código real, devolve contexto
    const novaEntrega = async (idem: string, name: string) => {
      const geo = await decideStoreForItemsGeo(client, ENV, {
        municipio: GEO_MUNI, items, modalidade: 'delivery',
        customerLocation: COPA, clientNeighborhoodCanonical: 'copacabana',
      });
      if (geo.kind !== 'partner') return null;
      const stockId = geo.routing.items[0]!.partner_stock_id;
      const before = (await client.query<{ on_hand: number; reserved: number }>(
        `SELECT quantity_on_hand AS on_hand, COALESCE(quantity_reserved,0) AS reserved
         FROM commerce.partner_stock_levels WHERE id=$1`, [stockId])).rows[0]!;
      const mat = await materializePartnerOrder(client, geo.routing.ctx, {
        customer_name: name, customer_phone: null,
        items: geo.routing.items.map((it) => ({ partner_stock_id: it.partner_stock_id, quantity: it.quantity, unit_price: it.central_price })),
        fulfillment_mode: 'delivery', delivery_address: 'Rua Teste, 100 — Copacabana',
        freight_amount: 0, idempotency_key: idem, reserve_for_pickup: false,
      });
      return { ctx: geo.routing.ctx, orderId: mat.partner_order_id, total: mat.total_amount, stockId, before };
    };
    const snap = async (stockId: string) => (await client.query<{ on_hand: number; reserved: number }>(
      `SELECT quantity_on_hand AS on_hand, COALESCE(quantity_reserved,0) AS reserved FROM commerce.partner_stock_levels WHERE id=$1`, [stockId])).rows[0]!;
    const nRec = async (orderId: string, status?: string) => Number((await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM finance.partner_receivables WHERE source_order_id=$1 ${status ? "AND status=$2" : ''}`,
      status ? [orderId, status] : [orderId])).rows[0]!.n);

    // ── CASE 1: entrega NÃO abre conta a receber no nascimento (a mudança) ─────
    await client.query('BEGIN');
    const e1 = await novaEntrega(`prova-ent-c1-${Date.now()}`, 'Entrega C1');
    if (!e1) { check('1) setup entrega', false, 'geo não roteou pra parceiro'); } else {
      const a = await snap(e1.stockId);
      check('1) entrega RESERVA o estoque (+1 reservado)', Number(a.reserved) === Number(e1.before.reserved) + 1, `reserved ${e1.before.reserved}→${a.reserved}`);
      check('1) entrega NÃO baixa on_hand no nascimento', Number(a.on_hand) === Number(e1.before.on_hand), `on_hand ${e1.before.on_hand}→${a.on_hand}`);
      check('1) entrega SEM conta a receber no nascimento (a mudança)', await nRec(e1.orderId) === 0, `recebíveis=${await nRec(e1.orderId)}`);
    }
    await client.query('ROLLBACK');

    // ── CASE 2: "marcar entregue" → baixa + 1 recebível JÁ 'received' (caixa) ──
    // Replica o handler updatePartnerDeliveryStatus(delivered): deliver_partner_local_order
    // + INSERT received com a MESMA idempotency_key (order:<id>:receivable).
    await client.query('BEGIN');
    const e2 = await novaEntrega(`prova-ent-c2-${Date.now()}`, 'Entrega C2');
    if (!e2) { check('2) setup entregar', false); } else {
      await client.query('SELECT commerce.deliver_partner_local_order($1,$2)', [e2.orderId, 'partner:geo-test']);
      await client.query(`UPDATE commerce.partner_orders SET delivery_status='delivered', status='paid', delivered_at=now() WHERE id=$1`, [e2.orderId]);
      await client.query(
        `INSERT INTO finance.partner_receivables (environment, unit_id, customer_id, customer_name, description, source_tag, amount, due_date, status, received_at, payment_method, notes, created_by, idempotency_key, source_order_id)
         VALUES ($1,$2,NULL,$3,$4,'2w',$5,NULL,'received',now(),'Pix',$6,'partner:geo-test',$7,$8)
         ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
         DO UPDATE SET status='received', received_at=now()`,
        [ENV, e2.ctx.unitId, 'Entrega C2', `Entrega ${e2.orderId.slice(0,8)}`, e2.total, `Entrega paga no recebimento`, `order:${e2.orderId}:receivable`, e2.orderId]);
      const a = await snap(e2.stockId);
      check('2) entregar: estoque BAIXOU 1 (reserva→venda)', Number(a.on_hand) === Number(e2.before.on_hand) - 1, `on_hand ${e2.before.on_hand}→${a.on_hand}`);
      check('2) entregar: reserva LIBERADA (volta ao original)', Number(a.reserved) === Number(e2.before.reserved), `reserved ${e2.before.reserved}→${a.reserved}`);
      check('2) entregar: caixa lançado (1 recebível RECEBIDO)', await nRec(e2.orderId, 'received') === 1, `recebidos=${await nRec(e2.orderId, 'received')}`);
      check('2) entregar: NÃO ficou recebível "open" pendurado', await nRec(e2.orderId, 'open') === 0, `abertos=${await nRec(e2.orderId, 'open')}`);
    }
    await client.query('ROLLBACK');

    // ── CASE 3: "não entregue" → libera reserva, SEM recebível, cancelado ──────
    await client.query('BEGIN');
    const e3 = await novaEntrega(`prova-ent-c3-${Date.now()}`, 'Entrega C3');
    if (!e3) { check('3) setup nao-entregue', false); } else {
      await client.query('SELECT commerce.cancel_partner_local_order($1,$2,$3)', [e3.orderId, 'partner:geo-test', 'cliente recusou na porta']);
      const a = await snap(e3.stockId);
      const st = (await client.query<{ status: string }>(`SELECT status FROM commerce.partner_orders WHERE id=$1`, [e3.orderId])).rows[0]!;
      check('3) nao-entregue: reserva LIBERADA', Number(a.reserved) === Number(e3.before.reserved), `reserved ${e3.before.reserved}→${a.reserved}`);
      check('3) nao-entregue: on_hand INTACTO (não inflou)', Number(a.on_hand) === Number(e3.before.on_hand), `on_hand ${e3.before.on_hand}→${a.on_hand}`);
      check('3) nao-entregue: SEM recebível', await nRec(e3.orderId) === 0, `recebíveis=${await nRec(e3.orderId)}`);
      check('3) nao-entregue: pedido cancelado', st.status === 'cancelled', st.status);
    }
    await client.query('ROLLBACK');

    // ── CASE 4: regressão — retirada continua SEM recebível no nascimento ──────
    await client.query('BEGIN');
    const geoP = await decideStoreForItemsGeo(client, ENV, {
      municipio: GEO_MUNI, items, modalidade: 'pickup', customerLocation: COPA, clientNeighborhoodCanonical: 'copacabana',
    });
    if (geoP.kind !== 'partner') { check('4) setup retirada', false); } else {
      const matP = await materializePartnerOrder(client, geoP.routing.ctx, {
        customer_name: 'Retira C4', customer_phone: null,
        items: geoP.routing.items.map((it) => ({ partner_stock_id: it.partner_stock_id, quantity: it.quantity, unit_price: it.central_price })),
        fulfillment_mode: 'pickup', delivery_address: null, freight_amount: 0,
        idempotency_key: `prova-ret-c4-${Date.now()}`, reserve_for_pickup: true,
      });
      check('4) regressão: retirada SEM recebível no nascimento', await nRec(matP.partner_order_id) === 0, `recebíveis=${await nRec(matP.partner_order_id)}`);
    }
    await client.query('ROLLBACK');

    console.log(`\n${fails === 0 ? '✅ ENTREGA = DINHEIRO SÓ NA ENTREGA: TODOS OS CASOS PASSARAM' : `❌ ${fails} CASO(S) FALHARAM`}`);
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
