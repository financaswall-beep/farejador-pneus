/**
 * Prova de integração — Tijolo 5 da foto sob demanda (amarração ao pedido).
 * BEGIN/ROLLBACK no env test: cria pedido REAL via register_partner_local_order
 * (a function de contrato; rollback desfaz reserva/baixa), foto respondida na
 * conversa, e prova que linkPhotoRequestsToOrder:
 *   1. gruda a foto no order_item certo (casamento por product_name do catálogo);
 *   2. NÃO gruda foto de outra unidade (guard re-roteamento);
 *   3. cancela os pending da conversa (sem fallback pós-compra).
 *
 * Uso: npx tsx --env-file=.env scripts/prova-foto-tijolo5.ts
 */
import { pool } from '../src/persistence/db.js';
import { createPhotoRequest, linkPhotoRequestsToOrder } from '../src/atendente-v2/photo-requests.js';

let passed = 0;
let failed = 0;
function ok(nome: string, cond: boolean, detalhe?: string): void {
  if (cond) { passed++; console.log(`PASS | ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
  else { failed++; console.log(`FAIL | ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Estoque REAL do env test com vínculo ao catálogo (a rede fake tem).
    const stock = await client.query<{
      stock_id: string; unit_id: string; product_id: string; product_name: string; slug: string;
    }>(
      `SELECT ps.id AS stock_id, ps.unit_id, ps.product_id, p.product_name, pu.slug
         FROM commerce.partner_stock_levels ps
         JOIN commerce.products p ON p.id = ps.product_id AND p.environment = ps.environment
         JOIN network.partner_units pu ON pu.unit_id = ps.unit_id AND pu.environment = ps.environment
        WHERE ps.environment = 'test' AND ps.deleted_at IS NULL AND ps.quantity_on_hand >= 1
        LIMIT 1`,
    );
    if (stock.rowCount !== 1) throw new Error('env test sem estoque vinculado ao catálogo — não dá pra provar');
    const s = stock.rows[0]!;
    console.log(`estoque de prova: ${s.product_name} @ ${s.slug}\n`);

    const conv = 666001;

    // Foto RESPONDIDA da conversa (como bot/owner: blob direto + answered).
    const created = await createPhotoRequest(client, 'test', {
      unitId: s.unit_id, chatwootConversationId: conv, tireSize: s.product_name, brand: null,
    });
    if (created.status !== 'created') throw new Error('setup: createPhotoRequest falhou');
    const prId = created.photoRequestId;
    await client.query(
      `INSERT INTO commerce.photo_request_blobs
         (photo_request_id, environment, unit_id, photo_bytes, photo_mime, photo_size_bytes)
       VALUES ($1, 'test', $2, $3, 'image/jpeg', 24)`,
      [prId, s.unit_id, Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex')],
    );
    await client.query(
      `UPDATE commerce.photo_requests SET status = 'answered', answered_at = now() WHERE id = $1`,
      [prId],
    );

    // Foto PENDENTE da conversa (deve virar cancelled ao fechar o pedido).
    // Criada ANTES do INSERT direto abaixo: o guard de máx 2 ativos por conversa
    // conta answered+pending — na 1ª rodada da prova ele barrou o 3º pedido
    // (o guard funcionando!), então o caminho com createPhotoRequest vem primeiro.
    const pend = await createPhotoRequest(client, 'test', {
      unitId: s.unit_id, chatwootConversationId: conv, tireSize: 'Outro pneu (PROVA T5)', brand: null,
    });
    if (pend.status !== 'created') throw new Error('setup: pending não criado');

    // Foto de OUTRA unidade na mesma conversa (guard deve barrar a migração).
    // INSERT direto de propósito (owner) — simula card respondido de loja antiga
    // antes de um re-roteamento; não passa pelo guard de máx-2 (e não precisa).
    const otherUnit = await client.query<{ unit_id: string }>(
      `SELECT unit_id FROM network.partner_units WHERE environment = 'test' AND unit_id <> $1 LIMIT 1`,
      [s.unit_id],
    );
    let prOtherId: string | null = null;
    if (otherUnit.rowCount === 1) {
      const ins = await client.query<{ id: string }>(
        `INSERT INTO commerce.photo_requests
           (environment, unit_id, conversation_id, tire_size, status, answered_at)
         VALUES ('test', $1, $2, $3, 'answered', now()) RETURNING id`,
        [otherUnit.rows[0]!.unit_id, conv, s.product_name],
      );
      prOtherId = ins.rows[0]!.id;
    }

    // Pedido REAL na unidade da foto (mesma chamada do materializePartnerOrder).
    const reg = await client.query<{ id: string }>(
      `SELECT commerce.register_partner_local_order(
         'test', $1, 'Cliente Prova T5', '+5521900000000',
         $2::jsonb, 'A receber', 'delivery', 'Rua da Prova, 123',
         'bot:prova-t5', $3, '2w', 0, 9.90, false
       ) AS id`,
      [
        s.unit_id,
        JSON.stringify([{ partner_stock_id: s.stock_id, quantity: 1, unit_price: 199.9 }]),
        `prova-t5:${Date.now()}`,
      ],
    );
    const orderId = reg.rows[0]!.id;

    // ── A AMARRAÇÃO ──
    await linkPhotoRequestsToOrder(client, 'test', conv, orderId);

    // 1. Foto da unidade certa grudou no item do pedido certo
    const linked = await client.query<{ order_item_id: string | null; order_id: string | null }>(
      `SELECT pr.order_item_id, poi.order_id
         FROM commerce.photo_requests pr
         LEFT JOIN commerce.partner_order_items poi ON poi.id = pr.order_item_id
        WHERE pr.id = $1`,
      [prId],
    );
    ok('foto grudou no item do pedido', linked.rows[0]!.order_item_id !== null && linked.rows[0]!.order_id === orderId);

    // 2. Foto de OUTRA unidade NÃO migrou (guard re-roteamento)
    if (prOtherId) {
      const other = await client.query<{ order_item_id: string | null }>(
        'SELECT order_item_id FROM commerce.photo_requests WHERE id = $1',
        [prOtherId],
      );
      ok('foto de outra loja NAO migrou (guard)', other.rows[0]!.order_item_id === null);
    } else {
      console.log('SKIP | guard outra loja (env test só tem 1 unidade)');
    }

    // 3. Pending da conversa virou cancelled (sem fallback pós-compra)
    const cancelled = await client.query<{ status: string }>(
      'SELECT status FROM commerce.photo_requests WHERE id = $1',
      [pend.status === 'created' ? pend.photoRequestId : ''],
    );
    ok('pending da conversa cancelado ao fechar pedido', cancelled.rows[0]!.status === 'cancelled');

    // 4. O mapa do feed (getPartnerVendas) acha a foto pelo pedido
    const feedMap = await client.query<{ photo_request_id: string }>(
      `SELECT pr.id AS photo_request_id
         FROM commerce.photo_requests pr
         JOIN commerce.partner_order_items poi ON poi.id = pr.order_item_id
        WHERE pr.environment = 'test' AND poi.order_id = $1`,
      [orderId],
    );
    ok('feed: mapa order->foto resolve', feedMap.rowCount === 1 && feedMap.rows[0]!.photo_request_id === prId);

    console.log(`\n${passed} PASS / ${failed} FAIL`);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
    await pool.end();
    console.log('ROLLBACK — pedido, reserva, fotos: nada persistiu.');
  }
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(`ERRO: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
