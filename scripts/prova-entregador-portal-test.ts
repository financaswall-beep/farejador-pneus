/**
 * PROVA de SEGURANÇA do PORTAL DO ENTREGADOR (0125, 2026-07-04). Roda no env
 * `test` chamando o CÓDIGO REAL. Trava os 8 cenários de ataque da revisão de
 * segurança pré-código + os requisitos obrigatórios:
 *   S1 login — vendedor/senha errada/revogado/sem-colaborador → null; entregador → token
 *   S2 sessão morre quando o colaborador é revogado (na hora)
 *   S3 IDOR de escrita: A não mexe em entrega da rota do B (status/não-entregue)
 *   S4 card financeiramente CEGO (zero custo/lucro/despesa/frete no payload)
 *   S5 prefixo do bearer: token sem es_ não é sessão (isStaffSessionToken)
 *   S7 comprovante alheio: A não lê o comprovante da rota do B
 *   S8 corrida de dupla rota (trip_already_open) + A não fecha a rota do B
 *   R9 NÃO-ENTREGUE só REPORTA: não cancela, galpão intocado
 *   + posse grava courier_collaborator_id/nome; zero grant do parceiro.
 * (S6 flag-off=404 e timing do login são HTTP — checados por curl no preview.)
 *
 * USO: npx tsx --env-file=.env.pooler scripts/prova-entregador-portal-test.ts
 */

process.env.MATRIZ_LOGISTICS = 'true';
process.env.MATRIZ_ENTREGADOR_PORTAL = 'true';

const ENV = 'test' as const;
const MARK = 'PROVA-ENTREGADOR';
const UA = 'prova.entregador.a';
const UB = 'prova.entregador.b';
const UV = 'prova.entregador.v';
const SENHA = 'senha-entregador-123';

async function main(): Promise<void> {
  const { pool } = await import('../src/persistence/db.js');
  const { env } = await import('../src/shared/config/env.js');
  const { applyMatrizGalpaoDecrement } = await import('../src/atendente-v2/wholesale-stock-read.js');
  const {
    createMatrizCollaborator, revokeMatrizCollaborator,
  } = await import('../src/admin/painel/queries.js');
  const {
    authenticateEntregador, validateEntregadorSession,
    getEntregadorRota, openEntregadorTrip, setEntregadorDeliveryStatus,
    reportEntregadorFail, closeEntregadorTrip, getEntregadorReceiptImage,
    isStaffSessionToken,
  } = await import('../src/admin/entregador/queries.js');

  if (env.FAREJADOR_ENV !== 'test') throw new Error('ABORTADO: só roda em test.');
  console.log('=== PROVA PORTAL DO ENTREGADOR (test) ===');

  let fails = 0;
  const check = (name: string, ok: boolean, extra = ''): void => {
    if (!ok) fails++;
    console.log(`  [${ok ? 'OK ' : 'XX '}] ${name}${extra ? ' — ' + extra : ''}`);
  };

  const client = await pool.connect();
  let productId = ''; let contactId = ''; let mainUnitId = '';

  const limpar = async (): Promise<void> => {
    await client.query(`UPDATE commerce.orders SET trip_id=NULL WHERE environment=$1 AND delivery_address LIKE $2`, [ENV, `%${MARK}%`]);
    await client.query(
      `DELETE FROM commerce.matriz_trip_receipt_blobs WHERE environment=$1 AND receipt_id IN (
         SELECT r.id FROM commerce.matriz_trip_receipts r JOIN commerce.matriz_delivery_trips t ON t.id=r.trip_id
          WHERE t.courier_name LIKE $2)`, [ENV, `%${MARK}%`]);
    await client.query(
      `DELETE FROM commerce.matriz_trip_receipts WHERE environment=$1 AND trip_id IN (
         SELECT id FROM commerce.matriz_delivery_trips WHERE environment=$1 AND courier_name LIKE $2)`, [ENV, `%${MARK}%`]);
    await client.query(`DELETE FROM commerce.matriz_delivery_trips WHERE environment=$1 AND courier_name LIKE $2`, [ENV, `%${MARK}%`]);
    await client.query(
      `DELETE FROM audit.events WHERE environment=$1 AND entity_id IN (
         SELECT id FROM commerce.orders WHERE environment=$1 AND delivery_address LIKE $2)`, [ENV, `%${MARK}%`]);
    await client.query(
      `DELETE FROM commerce.order_items WHERE environment=$1 AND order_id IN (
         SELECT id FROM commerce.orders WHERE environment=$1 AND delivery_address LIKE $2)`, [ENV, `%${MARK}%`]);
    await client.query(`DELETE FROM commerce.orders WHERE environment=$1 AND delivery_address LIKE $2`, [ENV, `%${MARK}%`]);
    await client.query(`DELETE FROM commerce.tire_specs WHERE environment=$1 AND product_id IN (SELECT id FROM commerce.products WHERE environment=$1 AND product_code LIKE $2)`, [ENV, `${MARK}-%`]);
    await client.query(`DELETE FROM commerce.products WHERE environment=$1 AND product_code LIKE $2`, [ENV, `${MARK}-%`]);
    await client.query(`DELETE FROM core.contacts WHERE environment=$1 AND name=$2`, [ENV, `${MARK} contato`]);
    // colaboradores + pessoas + sessões da prova
    await client.query(
      `DELETE FROM network.matriz_staff_sessions WHERE environment=$1 AND person_id IN (
         SELECT id FROM network.partner_people WHERE environment=$1 AND lower(username) LIKE 'prova.entregador.%')`, [ENV]);
    await client.query(
      `DELETE FROM network.matriz_collaborators WHERE environment=$1 AND person_id IN (
         SELECT id FROM network.partner_people WHERE environment=$1 AND lower(username) LIKE 'prova.entregador.%')`, [ENV]);
    await client.query(`DELETE FROM network.partner_people WHERE environment=$1 AND lower(username) LIKE 'prova.entregador.%'`, [ENV]);
  };

  const qtyGalpao = async (measure: string): Promise<number> => {
    const r = await client.query<{ q: string }>(`SELECT quantity_on_hand AS q FROM commerce.wholesale_stock WHERE environment=$1 AND measure=$2`, [ENV, measure]);
    return Number(r.rows[0]?.q ?? -1);
  };
  const seedOrder = async (qty = 1, total = 150): Promise<string> => {
    const o = await client.query<{ id: string }>(
      `INSERT INTO commerce.orders (environment, contact_id, total_amount, status, fulfillment_mode, delivery_address, unit_id)
       VALUES ($1::env_t,$2,$3,'open','delivery',$4,$5) RETURNING id`,
      [ENV, contactId, total, `Rua ${MARK}, 10 - Centro - Rio`, mainUnitId]);
    const id = o.rows[0]!.id;
    await client.query(
      `INSERT INTO commerce.order_items (environment, order_id, product_id, quantity, unit_price, discount_amount, matriz_unit_cost)
       VALUES ($1::env_t,$2,$3,$4,100,0,20)`, [ENV, id, productId, qty]);
    return id;
  };

  await limpar();
  try {
    // ── setup ──
    const mu = await client.query<{ id: string }>(`SELECT id FROM core.units WHERE environment=$1 AND slug='main'`, [ENV]);
    if (!mu.rows[0]) throw new Error('unit main não existe no env test.');
    mainUnitId = mu.rows[0].id;
    const MEASURE = '96/96-96';
    const prod = await client.query<{ id: string }>(
      `INSERT INTO commerce.products (environment, product_code, product_name, product_type, brand)
       VALUES ($1::env_t,$2,'${MARK} pneu','tire','PROVA') RETURNING id`, [ENV, `${MARK}-${Date.now() % 1000000}`]);
    productId = prod.rows[0]!.id;
    await client.query(`INSERT INTO commerce.tire_specs (environment, product_id, tire_size, width_mm, aspect_ratio, rim_diameter) VALUES ($1::env_t,$2,$3,96,96,96)`, [ENV, productId, MEASURE]);
    await client.query(`DELETE FROM commerce.wholesale_stock WHERE environment=$1 AND measure=$2`, [ENV, MEASURE]);
    await client.query(`INSERT INTO commerce.wholesale_stock (environment, measure, quantity_on_hand, unit_cost) VALUES ($1,$2,10,20)`, [ENV, MEASURE]);
    const c = await client.query<{ id: string }>(
      `INSERT INTO core.contacts (environment, chatwoot_contact_id, name, phone_e164) VALUES ($1::env_t,$2,$3,'+5521988887777') RETURNING id`,
      [ENV, Date.now() % 2000000000, `${MARK} contato`]);
    contactId = c.rows[0]!.id;

    // colaboradores: A e B entregadores, V vendedor
    const colA = await createMatrizCollaborator({ environment: ENV, display_name: `A ${MARK}`, username: UA, password: SENHA, job: 'entregador' });
    await createMatrizCollaborator({ environment: ENV, display_name: `B ${MARK}`, username: UB, password: SENHA, job: 'entregador' });
    const colV = await createMatrizCollaborator({ environment: ENV, display_name: `V ${MARK}`, username: UV, password: SENHA, job: 'vendedor' });

    // ── S1: LOGIN — só entregador com senha certa entra ──
    check('S1a vendedor NÃO entra no portal (job≠entregador → null)', (await authenticateEntregador(ENV, UV, SENHA)) === null);
    check('S1b senha errada → null', (await authenticateEntregador(ENV, UA, 'errada-999')) === null);
    check('S1c usuário inexistente → null', (await authenticateEntregador(ENV, 'prova.entregador.zzz', SENHA)) === null);
    // S1f (furo #1 da banca): pessoa que existe SEM senha própria (password_hash NULL —
    // real na porta única 0095) NÃO pode vazar "existe" pelo timing. O WHERE exige
    // password_hash IS NOT NULL → cai no MESMO ramo de inexistente (null, via fakeVerify).
    await client.query(
      `INSERT INTO network.partner_people (environment, username, password_hash, password_set_at)
       VALUES ($1, 'prova.entregador.nopw', NULL, NULL)`, [ENV]);
    check('S1f pessoa sem senha (hash NULL) → null (não vaza "existe" por timing)',
      (await authenticateEntregador(ENV, 'prova.entregador.nopw', SENHA)) === null);
    const loginA = await authenticateEntregador(ENV, UA, SENHA);
    const loginB = await authenticateEntregador(ENV, UB, SENHA);
    check('S1d entregador com senha certa → token es_', !!loginA && isStaffSessionToken(loginA.session_token));

    const authA = await validateEntregadorSession(ENV, loginA!.session_token);
    const authB = await validateEntregadorSession(ENV, loginB!.session_token);
    check('S1e sessão válida resolve o colaborador certo', authA?.collaboratorId === colA.id && authA?.displayName === `A ${MARK}`);

    // ── S5: prefixo do bearer ──
    check('S5 token sem prefixo es_ NÃO é sessão do portal', !isStaffSessionToken('ps_' + 'a'.repeat(64)) && !isStaffSessionToken('lixo'));

    // ── S2: revogar o colaborador MATA a sessão na hora ──
    const loginV2 = await authenticateEntregador(ENV, UA, SENHA); // 2ª sessão do A (viva)
    await revokeMatrizCollaborator({ environment: ENV, id: colA.id });
    check('S2a sessão do A morre após revogar o colaborador', (await validateEntregadorSession(ENV, loginA!.session_token)) === null);
    check('S2b 2ª sessão do A também morre (revoke apaga todas)', (await validateEntregadorSession(ENV, loginV2!.session_token)) === null);
    check('S2c login do A revogado → null', (await authenticateEntregador(ENV, UA, SENHA)) === null);
    // recria o A pra seguir (username liberado pela revogação)
    const colA2 = await createMatrizCollaborator({ environment: ENV, display_name: `A ${MARK}`, username: UA, password: SENHA, job: 'entregador' });
    const authA2 = await validateEntregadorSession(ENV, (await authenticateEntregador(ENV, UA, SENHA))!.session_token);
    check('S2d A recriado loga de novo', !!authA2 && authA2.collaboratorId === colA2.id);

    // ── abrir rotas: A com O1; B com O2 + O3 (O3 já baixou o galpão, pra provar o R9) ──
    const o1 = await seedOrder(); const o2 = await seedOrder(); const o3 = await seedOrder(2);
    await applyMatrizGalpaoDecrement(client, ENV, [{ productId, quantity: 2 }], true, o3);
    const tripA = await openEntregadorTrip(authA2!, { km_start: 1000, order_ids: [o1] }, ENV);
    const tripB = await openEntregadorTrip(authB!, { km_start: 2000, order_ids: [o2, o3] }, ENV);
    check('rotas abertas independentes', tripA.trip_id !== tripB.trip_id && tripA.deliveries_count === 1);
    const tripArow = (await client.query(`SELECT courier_collaborator_id, courier_name FROM commerce.matriz_delivery_trips WHERE id=$1`, [tripA.trip_id])).rows[0] as { courier_collaborator_id: string; courier_name: string };
    check('R7 rota grava o dono (courier_collaborator_id + nome)', tripArow.courier_collaborator_id === colA2.id && tripArow.courier_name === `A ${MARK}`);

    // ── S8: A já tem rota aberta → segunda abre estoura ──
    let dobrou = false;
    try { await openEntregadorTrip(authA2!, { km_start: 1, order_ids: [o1] }, ENV); }
    catch (e) { dobrou = (e as Error).message === 'trip_already_open'; }
    check('S8a A não abre 2ª rota (trip_already_open)', dobrou);

    // ── S3: IDOR de escrita — B mexe na entrega do A ──
    let idor1 = false;
    try { await setEntregadorDeliveryStatus(authB!, { order_id: o1, status: 'delivered', payment_method: 'dinheiro' }, ENV); }
    catch (e) { idor1 = (e as Error).message === 'delivery_not_found'; }
    const o1still = (await client.query(`SELECT delivery_status FROM commerce.orders WHERE id=$1`, [o1])).rows[0] as { delivery_status: string };
    check('S3a B NÃO entrega o pedido do A (delivery_not_found) e o pedido fica intacto', idor1 && o1still.delivery_status === 'dispatched');
    let idor2 = false;
    try { await reportEntregadorFail(authB!, { order_id: o1, reason: 'roubo de rota' }, ENV); }
    catch (e) { idor2 = (e as Error).message === 'delivery_not_found'; }
    check('S3b B NÃO reporta falha no pedido do A', idor2);

    // ── S8b: A não fecha a rota do B (fecha só a própria — sem trip_id do cliente) ──
    await closeEntregadorTrip(authA2!, { km_end: 1050, fuel_spent: null }, ENV);
    const tripBstatus = (await client.query(`SELECT status FROM commerce.matriz_delivery_trips WHERE id=$1`, [tripB.trip_id])).rows[0] as { status: string };
    check('S8b A fechou a PRÓPRIA rota; a do B segue aberta', tripBstatus.status === 'open');
    const tripAstatus = (await client.query(`SELECT status FROM commerce.matriz_delivery_trips WHERE id=$1`, [tripA.trip_id])).rows[0] as { status: string };
    check('S8c a rota do A fechou', tripAstatus.status === 'closed');

    // ── R9: NÃO-ENTREGUE só REPORTA (não cancela, galpão intocado). o3 está na rota do B. ──
    const antes = await qtyGalpao(MEASURE);
    await reportEntregadorFail(authB!, { order_id: o3, reason: 'cliente ausente' }, ENV);
    const o3row = (await client.query(`SELECT status, delivery_status, delivery_failure_reason FROM commerce.orders WHERE id=$1`, [o3])).rows[0] as { status: string; delivery_status: string; delivery_failure_reason: string };
    check('R9a reporta failed + motivo, SEM cancelar', o3row.delivery_status === 'failed' && o3row.status !== 'cancelled' && o3row.delivery_failure_reason === 'cliente ausente');
    check('R9b galpão INTOCADO (o dono é quem confirma/devolve)', (await qtyGalpao(MEASURE)) === antes, `qty=${await qtyGalpao(MEASURE)} antes=${antes}`);

    // ── entregar de verdade grava o NOME do entregador na trilha ──
    const o4 = await seedOrder();
    // B já tem rota aberta (tripB com o2, e tripB2 com o3). Põe o4 na do B abrindo? Não — usa a do A: reabrir A.
    const authAnew = await validateEntregadorSession(ENV, (await authenticateEntregador(ENV, UA, SENHA))!.session_token);
    const tripA2 = await openEntregadorTrip(authAnew!, { km_start: 5000, order_ids: [o4] }, ENV); void tripA2;
    await setEntregadorDeliveryStatus(authAnew!, { order_id: o4, status: 'delivered', payment_method: 'pix' }, ENV);
    const o4row = (await client.query(`SELECT status, closed_by, delivery_courier, payment_method FROM commerce.orders WHERE id=$1`, [o4])).rows[0] as { status: string; closed_by: string; delivery_courier: string; payment_method: string };
    check('R7b entregue grava o NOME do entregador (closed_by/courier) e o pagamento', o4row.status === 'delivered' && o4row.closed_by === `A ${MARK}` && o4row.delivery_courier === `A ${MARK}` && o4row.payment_method === 'pix');

    // ── S4: card financeiramente CEGO ──
    const rota = await getEntregadorRota(authB!, ENV);
    const blob = JSON.stringify(rota).toLowerCase();
    // tokens PRECISOS (nada de 'custo' cru — bate em "customer", campo legítimo)
    const proibidos = ['matriz_unit_cost', 'unit_cost', 'lucro', 'despesa', 'frete', 'expense', 'resumo', 'margem', 'profit'];
    const achou = proibidos.filter((p) => blob.includes(p));
    check('S4a payload da rota NÃO traz custo/lucro/despesa/frete', achou.length === 0, achou.length ? `vazou: ${achou.join(',')}` : '');
    const card = rota.rota_aberta?.entregas[0] || rota.fila[0];
    check('S4b card tem "cobrar" (total cru) e itens', !!card && card.cobrar !== undefined && Array.isArray(card.items));

    // ── S7: comprovante alheio — A não lê o comprovante da rota do B ──
    // planta um comprovante fake na rota aberta do B (o2/tripB)
    const rcpt = await client.query<{ id: string }>(
      `INSERT INTO commerce.matriz_trip_receipts (environment, trip_id, mime, size_bytes, ai_status) VALUES ($1,$2,'image/jpeg',3,'skipped') RETURNING id`, [ENV, tripB.trip_id]);
    await client.query(`INSERT INTO commerce.matriz_trip_receipt_blobs (environment, receipt_id, bytes) VALUES ($1,$2,$3)`, [ENV, rcpt.rows[0]!.id, Buffer.from([1, 2, 3])]);
    const doB = await getEntregadorReceiptImage(authB!, rcpt.rows[0]!.id, ENV);
    const doA = await getEntregadorReceiptImage(authAnew!, rcpt.rows[0]!.id, ENV);
    check('S7 B lê o próprio comprovante; A (dono de outra rota) recebe null', !!doB && doA === null);

    // ── zero grant do parceiro na tabela de sessão nova ──
    const grants = await client.query<{ sel: boolean; ins: boolean }>(
      `SELECT has_table_privilege('farejador_partner_app','network.matriz_staff_sessions','SELECT') AS sel,
              has_table_privilege('farejador_partner_app','network.matriz_staff_sessions','INSERT') AS ins`);
    check('ZG farejador_partner_app NÃO acessa matriz_staff_sessions', grants.rows[0]?.sel === false && grants.rows[0]?.ins === false);

  } finally {
    await limpar();
    client.release();
    await pool.end();
  }

  console.log(fails === 0 ? '\n✅ PROVA PORTAL DO ENTREGADOR: tudo verde.' : `\n❌ PROVA PORTAL: ${fails} falha(s).`);
  if (fails > 0) process.exitCode = 1;
}

main().catch((err) => { console.error('PROVA quebrou:', err); process.exitCode = 1; });
