/**
 * PROVA de INTEGRAÇÃO da LOGÍSTICA DA MATRIZ (0121, 2026-07-03). Roda no env `test`
 * chamando o CÓDIGO REAL. Blinda:
 *   fila só enxerga entrega da MAIN (pickup/outra unit ficam fora, leitura E escrita) ·
 *   termômetro (saiu → entregue fecha o pedido) · NÃO ENTREGUE cancela e o galpão
 *   VOLTA (caminho fdd9148) · rota abre com as entregas certas (inválidas ficam fora) ·
 *   fechar rota com gasolina só anota e nunca lança despesa (fechar 2x barra) ·
 *   IA só sugere; dinheiro nasce apenas após decisão humana autenticada ·
 *   sugestão e aprovação são idempotentes · unreadable NÃO lança ·
 *   blob do comprovante salva e volta byte a byte · "A ROTA SE PAGOU?" (frete
 *   embutido + lucro pela régua 0117 + despesas amarradas; falha fora; soft
 *   delete de despesa reflete).
 *
 * Seeds descartáveis (medida '95/95-95', PROVA-LOG) e LIMPA no finally.
 *
 * USO:
 *   npx tsx --env-file=.env.pooler scripts/prova-logistica-matriz-test.ts
 */

process.env.MATRIZ_LOGISTICS = 'true';
process.env.MATRIZ_EXPENSES = 'true';
process.env.MATRIZ_RECEIPT_AI = 'true';
process.env.MATRIZ_RECEIPT_APPROVAL = 'true';

const ENV = 'test' as const;
const MEASURE = '95/95-95';

async function main(): Promise<void> {
  const { pool } = await import('../src/persistence/db.js');
  const { env } = await import('../src/shared/config/env.js');
  const { applyMatrizGalpaoDecrement } = await import('../src/atendente-v2/wholesale-stock-read.js');
  const {
    getMatrizLogistica, setMatrizDeliveryStatus, failMatrizDelivery, requeueMatrizDelivery,
    openMatrizTrip, attachOrderToMatrizTrip, rescheduleMatrizDelivery, closeMatrizTrip, addMatrizTripReceipt,
    getMatrizTripReceiptImage, beginReceiptAiAttempt, completeReceiptAiAttempt,
    approveMatrizTripReceipt,
  } = await import('../src/admin/painel/queries.js');

  if (env.FAREJADOR_ENV !== 'test') throw new Error('ABORTADO: só roda em test.');
  console.log('=== PROVA LOGÍSTICA DA MATRIZ (test) ===');

  const client = await pool.connect();
  let fails = 0;
  let productId = '';
  let contactId = '';
  let mainUnitId = '';
  const orderIds: string[] = [];
  const tripIds: string[] = [];
  const runMarker = `PROVA-LOG-${Date.now()}`;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const competenceMonth = `${today.slice(0, 7)}-01`;
  let savepointSequence = 0;
  let transactionQueryQueue: Promise<unknown> = Promise.resolve();
  const queuedQuery = (text: string, values?: unknown[]) => {
    const result = transactionQueryQueue.then(() => client.query(text, values));
    transactionQueryQueue = result.then(() => undefined, () => undefined);
    return result;
  };
  const transactionPool = {
    query: queuedQuery,
    connect: async () => {
      const savepoint = `prova_log_${++savepointSequence}`;
      let active = false;
      return {
        query: async (text: string, values?: unknown[]) => {
          const command = text.trim().toUpperCase();
          if (command === 'BEGIN') {
            active = true;
            return queuedQuery(`SAVEPOINT ${savepoint}`);
          }
          if (command === 'COMMIT') {
            active = false;
            return queuedQuery(`RELEASE SAVEPOINT ${savepoint}`);
          }
          if (command === 'ROLLBACK') {
            if (!active) return queuedQuery('SELECT 1');
            await queuedQuery(`ROLLBACK TO SAVEPOINT ${savepoint}`);
            active = false;
            return queuedQuery(`RELEASE SAVEPOINT ${savepoint}`);
          }
          return queuedQuery(text, values);
        },
        release: () => undefined,
      };
    },
  } as unknown as typeof pool;
  const migration = await client.query<{ installed: string | null }>(
    `SELECT to_regclass('commerce.matriz_trip_receipt_decisions')::text AS installed`);
  if (!migration.rows[0]?.installed) {
    throw new Error('ABORTADO: migration 0140 ainda não aplicada no banco de teste.');
  }
  const check = (name: string, ok: boolean, extra = ''): void => {
    if (!ok) fails++;
    console.log(`  [${ok ? 'OK ' : 'XX '}] ${name}${extra ? ' — ' + extra : ''}`);
  };
  const qtyOf = async (): Promise<number> => {
    const r = await client.query<{ q: string }>(
      `SELECT quantity_on_hand AS q FROM commerce.wholesale_stock WHERE environment=$1 AND measure=$2`, [ENV, MEASURE]);
    return Number(r.rows[0]?.q ?? -1);
  };
  const despesasProva = async (): Promise<number> => {
    const r = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM commerce.matriz_expenses
        WHERE environment=$1 AND deleted_at IS NULL
          AND created_by LIKE 'comprovante:%'
          AND description LIKE $2`, [ENV, `%${runMarker}%`]);
    return Number(r.rows[0]!.n);
  };
  const seedOrder = async (opts: { mode?: 'delivery' | 'pickup'; unitId?: string | null; qty?: number; total?: number; unitCost?: number | null; discount?: number }): Promise<string> => {
    const mode = opts.mode ?? 'delivery';
    const o = await client.query<{ id: string }>(
      `INSERT INTO commerce.orders (environment, contact_id, total_amount, status, fulfillment_mode, delivery_address, unit_id)
       VALUES ($1::env_t, $2, $3, 'open', $4, $5, $6) RETURNING id`,
      [ENV, contactId, opts.total ?? 100, mode, mode === 'delivery' ? 'Rua PROVA-LOG, 1 - Centro - Rio' : null, opts.unitId ?? null]);
    const id = o.rows[0]!.id;
    await client.query(
      `INSERT INTO commerce.order_items (environment, order_id, product_id, quantity, unit_price, discount_amount, matriz_unit_cost)
       VALUES ($1::env_t, $2, $3, $4, 100, $5, $6)`, [ENV, id, productId, opts.qty ?? 1, opts.discount ?? 0, opts.unitCost ?? null]);
    orderIds.push(id);
    return id;
  };

  try {
    // ── PRÉ-LIMPEZA (banca 07-03): run anterior interrompido não pode envenenar
    // este (o finally só limpa o que ESTE processo rastreou). Varre por marcador. ──
    await client.query(
      `UPDATE commerce.orders SET trip_id=NULL WHERE environment=$1 AND delivery_address LIKE '%PROVA-LOG%'`, [ENV]);
    await client.query(
      `DELETE FROM commerce.matriz_trip_receipt_blobs WHERE environment=$1 AND receipt_id IN (
         SELECT r.id FROM commerce.matriz_trip_receipts r
         JOIN commerce.matriz_delivery_trips t ON t.id = r.trip_id
        WHERE t.courier_name IN ('Zé da Moto','Maria PROVA-LOG','Rota-Fecha-Antes PROVA-LOG','Resumo PROVA-LOG','Pendura PROVA-LOG','Vazia PROVA-LOG'))`, [ENV]);
    await client.query(
      `DELETE FROM commerce.matriz_trip_receipts WHERE environment=$1 AND trip_id IN (
         SELECT id FROM commerce.matriz_delivery_trips WHERE environment=$1 AND courier_name IN ('Zé da Moto','Maria PROVA-LOG','Rota-Fecha-Antes PROVA-LOG','Resumo PROVA-LOG','Pendura PROVA-LOG','Vazia PROVA-LOG'))`, [ENV]);
    await client.query(
      `DELETE FROM commerce.matriz_delivery_trips WHERE environment=$1 AND courier_name IN ('Zé da Moto','Maria PROVA-LOG','Rota-Fecha-Antes PROVA-LOG','Resumo PROVA-LOG','Pendura PROVA-LOG','Vazia PROVA-LOG')`, [ENV]);
    await client.query(
      `DELETE FROM commerce.matriz_expenses WHERE environment=$1 AND created_by IN ('logistica-fechamento','ia-comprovante') AND description LIKE '%PROVA-LOG%'`, [ENV]);
    await client.query(
      `DELETE FROM audit.events WHERE environment=$1 AND entity_id IN (
         SELECT o.id FROM commerce.orders o WHERE o.environment=$1 AND o.delivery_address LIKE '%PROVA-LOG%')`, [ENV]);
    await client.query(
      `DELETE FROM commerce.order_items WHERE environment=$1 AND order_id IN (
         SELECT id FROM commerce.orders WHERE environment=$1 AND delivery_address LIKE '%PROVA-LOG%')`, [ENV]);
    await client.query(
      `DELETE FROM commerce.order_items WHERE environment=$1 AND product_id IN (
         SELECT id FROM commerce.products WHERE environment=$1 AND product_code LIKE 'PROVA-LOG-%')`, [ENV]);
    await client.query(
      `DELETE FROM commerce.orders WHERE environment=$1 AND (delivery_address LIKE '%PROVA-LOG%'
         OR id IN (SELECT DISTINCT order_id FROM commerce.order_items WHERE environment=$1 AND product_id IN (
              SELECT id FROM commerce.products WHERE environment=$1 AND product_code LIKE 'PROVA-LOG-%')))`, [ENV]);
    await client.query(
      `DELETE FROM commerce.tire_specs WHERE environment=$1 AND product_id IN (
         SELECT id FROM commerce.products WHERE environment=$1 AND product_code LIKE 'PROVA-LOG-%')`, [ENV]);
    await client.query(`DELETE FROM commerce.products WHERE environment=$1 AND product_code LIKE 'PROVA-LOG-%'`, [ENV]);
    await client.query(`DELETE FROM core.contacts WHERE environment=$1 AND name='PROVA-LOG contato'`, [ENV]);

    // ── setup: unit main + produto + galpão(10×R$20) + contato ──
    const mu = await client.query<{ id: string }>(
      `SELECT id FROM core.units WHERE environment=$1 AND slug='main'`, [ENV]);
    if (!mu.rows[0]) throw new Error('unit main não existe no env test — rodar seed da matriz antes.');
    mainUnitId = mu.rows[0].id;
    const prod = await client.query<{ id: string }>(
      `INSERT INTO commerce.products (environment, product_code, product_name, product_type, brand)
       VALUES ($1::env_t, $2, 'PROVA-LOG pneu', 'tire', 'PROVA') RETURNING id`, [ENV, 'PROVA-LOG-' + (Date.now() % 1000000)]);
    productId = prod.rows[0]!.id;
    await client.query(
      `INSERT INTO commerce.tire_specs (environment, product_id, tire_size, width_mm, aspect_ratio, rim_diameter)
       VALUES ($1::env_t, $2, $3, 95, 95, 95)`, [ENV, productId, MEASURE]);
    await client.query(`DELETE FROM commerce.wholesale_stock WHERE environment=$1 AND measure=$2`, [ENV, MEASURE]);
    await client.query(
      `INSERT INTO commerce.wholesale_stock (environment, measure, quantity_on_hand, unit_cost) VALUES ($1,$2,10,20)`, [ENV, MEASURE]);
    const c = await client.query<{ id: string }>(
      `INSERT INTO core.contacts (environment, chatwoot_contact_id, name, phone_e164)
       VALUES ($1::env_t, $2, 'PROVA-LOG contato', '+5521900000000') RETURNING id`, [ENV, Date.now() % 2000000000]);
    contactId = c.rows[0]!.id;
    check('setup: unit main + produto + galpão 10un + contato', (await qtyOf()) === 10);

    // ── L1: entrega da main aparece na fila; pickup e sem-unit ficam FORA ──
    const oMain = await seedOrder({ unitId: mainUnitId });
    const oPickup = await seedOrder({ mode: 'pickup', unitId: mainUnitId });
    const oSemUnit = await seedOrder({ unitId: null });
    let log = await getMatrizLogistica(ENV);
    const ids = log.abertas.map((d) => d.order_id);
    check('L1 fila enxerga SÓ entrega da main', ids.includes(oMain) && !ids.includes(oPickup) && !ids.includes(oSemUnit),
      `abertas=${ids.length}`);

    // ── L2: guard de ESCRITA — pedido fora da main não atualiza ──
    let barrou = false;
    try { await setMatrizDeliveryStatus({ order_id: oSemUnit, status: 'dispatched', environment: ENV }); }
    catch (e) { barrou = (e as Error).message === 'delivery_not_found'; }
    check('L2 escrita barrada fora da main (delivery_not_found)', barrou);

    // ── L3: saiu pra entrega ──
    await setMatrizDeliveryStatus({ order_id: oMain, status: 'dispatched', courier: 'Zé da Moto', environment: ENV });
    let row = (await client.query(`SELECT delivery_status, delivery_courier, dispatched_at FROM commerce.orders WHERE id=$1`, [oMain])).rows[0] as { delivery_status: string; delivery_courier: string; dispatched_at: string | null };
    check('L3 saiu pra entrega (dispatched + entregador + carimbo)',
      row.delivery_status === 'dispatched' && row.delivery_courier === 'Zé da Moto' && row.dispatched_at !== null);

    // ── L4: entregue fecha o pedido ──
    await setMatrizDeliveryStatus({ order_id: oMain, status: 'delivered', payment_method: 'Pix', environment: ENV });
    const done = (await client.query(`SELECT status, delivery_status, delivered_at, payment_method FROM commerce.orders WHERE id=$1`, [oMain])).rows[0] as { status: string; delivery_status: string; delivered_at: string | null; payment_method: string };
    log = await getMatrizLogistica(ENV);
    check('L4 entregue: pedido delivered + carimbo + pagamento + sai da fila',
      done.status === 'delivered' && done.delivery_status === 'delivered' && done.delivered_at !== null
      && done.payment_method === 'Pix' && !log.abertas.some((d) => d.order_id === oMain)
      && log.finalizadas.some((d) => d.order_id === oMain));

    // ── L5: NÃO ENTREGUE cancela e o galpão VOLTA (fdd9148) ──
    const oFail = await seedOrder({ unitId: mainUnitId, qty: 3 });
    await applyMatrizGalpaoDecrement(client, ENV, [{ productId, quantity: 3 }], true, oFail);
    check('L5a venda baixou o galpão (10→7)', (await qtyOf()) === 7, `qty=${await qtyOf()}`);
    await failMatrizDelivery({ order_id: oFail, reason: 'cliente não estava', actor_label: 'prova-log', environment: ENV });
    const failed = (await client.query(`SELECT status, delivery_status FROM commerce.orders WHERE id=$1`, [oFail])).rows[0] as { status: string; delivery_status: string };
    check('L5b não entregue: failed + cancelado + galpão VOLTA (7→10)',
      failed.status === 'cancelled' && failed.delivery_status === 'failed' && (await qtyOf()) === 10, `qty=${await qtyOf()}`);

    // ── L6: abrir rota — só a entrega válida entra ──
    const oRota = await seedOrder({ unitId: mainUnitId });
    const trip1 = await openMatrizTrip({
      courier_name: 'Zé da Moto', km_start: 45000,
      order_ids: [oRota, oPickup, oFail], // pickup e cancelado NÃO podem entrar
      environment: ENV,
    });
    tripIds.push(trip1.trip_id);
    const rotaRow = (await client.query(`SELECT delivery_status, trip_id, delivery_courier FROM commerce.orders WHERE id=$1`, [oRota])).rows[0] as { delivery_status: string; trip_id: string; delivery_courier: string };
    check('L6 rota abre com 1 de 3 (pickup/cancelado ficam fora) e a entrega SAI',
      trip1.deliveries_count === 1 && rotaRow.delivery_status === 'dispatched'
      && rotaRow.trip_id === trip1.trip_id && rotaRow.delivery_courier === 'Zé da Moto',
      `entraram=${trip1.deliveries_count}`);

    // ── L7-L14: contrato 0140. A seção roda numa transação externa e sempre
    // desfaz seus registros append-only; as transações reais viram savepoints. ──
    const fakeReceipt = (label: string): Buffer => Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.from(`${runMarker}-${label}`.repeat(10)),
    ]);
    const fakeJpeg = fakeReceipt('RECIBO-1');
    await client.query('BEGIN');
    try {
      const rec1 = await addMatrizTripReceipt({ trip_id: trip1.trip_id,
        bytes: fakeJpeg, mime: 'image/jpeg', environment: ENV }, transactionPool);
      const img = await getMatrizTripReceiptImage(rec1.receipt_id, ENV, transactionPool);
      check('L7 comprovante guardado (uploaded/pending) e blob volta byte a byte',
        rec1.ai_status === 'pending' && img !== null && Buffer.compare(img!.bytes, fakeJpeg) === 0);

      const antes = await despesasProva();
      const attempt1 = await beginReceiptAiAttempt({ receipt_id: rec1.receipt_id,
        environment: ENV, model: 'prova-log-model', extractor_version: 'prova-v1',
        prompt_version: 'prova-p1' }, transactionPool);
      const suggested1 = await completeReceiptAiAttempt({ attempt_id: attempt1.attempt_id,
        environment: ENV, result: { status: 'suggested', category: 'combustivel',
          amount: 187.3, merchant: `Posto ${runMarker}`, document_date: today,
          confidence: 0.93, summary: `Posto ${runMarker} · R$ 187,30` } }, transactionPool);
      const afterSuggestion = (await client.query<{ workflow_status: string; ai_expense_id: string | null }>(
        `SELECT workflow_status,ai_expense_id FROM commerce.matriz_trip_receipts WHERE id=$1`,
        [rec1.receipt_id])).rows[0]!;
      check('L8 IA só sugere: review_required, zero expense_id e zero dinheiro',
        suggested1.status === 'suggested' && afterSuggestion.workflow_status === 'review_required'
        && afterSuggestion.ai_expense_id === null && (await despesasProva()) === antes);

      const attempt2 = await beginReceiptAiAttempt({ receipt_id: rec1.receipt_id,
        environment: ENV, model: 'prova-log-model', extractor_version: 'prova-v1',
        prompt_version: 'prova-p1' }, transactionPool);
      await completeReceiptAiAttempt({ attempt_id: attempt2.attempt_id, environment: ENV,
        result: { status: 'suggested', category: 'combustivel', amount: 187.3,
          merchant: `Posto ${runMarker}`, document_date: today, confidence: 0.95,
          summary: `Releitura ${runMarker} · R$ 187,30` } }, transactionPool);
      const attemptCount = Number((await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM commerce.matriz_trip_receipt_ai_attempts WHERE receipt_id=$1`,
        [rec1.receipt_id])).rows[0]!.n);
      check('L9 re-leitura cria histórico imutável, mas continua sem lançar dinheiro',
        attemptCount === 2 && (await despesasProva()) === antes);

      const approval1 = { receipt_id: rec1.receipt_id, ai_attempt_id: attempt2.attempt_id,
        amount: 187.3, suggested_amount: 187.3, category: 'combustivel',
        merchant: `Posto ${runMarker}`, document_date: today,
        competence_month: competenceMonth, payment_status: 'paid' as const,
        payment_date: today, possible_duplicate_confirmed: true,
        idempotency_key: `${runMarker}-approve-1`, actor_label: 'prova-logistica',
        note: `${runMarker} aprovação humana`, environment: ENV };
      const approved1 = await approveMatrizTripReceipt(approval1, transactionPool);
      check('L10a só a aprovação humana cria e liga UMA despesa',
        approved1.workflow_status === 'linked' && (await despesasProva()) === antes + 1);
      const replay1 = await approveMatrizTripReceipt(approval1, transactionPool);
      check('L10b retry da aprovação devolve a mesma decisão e a mesma despesa',
        replay1.decision_id === approved1.decision_id && replay1.expense_id === approved1.expense_id
        && (await despesasProva()) === antes + 1);
      const fech1 = await closeMatrizTrip({ trip_id: trip1.trip_id, km_end: 45080,
        fuel_spent: 187.3, environment: ENV }, transactionPool);
      const t1 = (await client.query(`SELECT status,km_end,fuel_spent,fuel_expense_id
        FROM commerce.matriz_delivery_trips WHERE id=$1`, [trip1.trip_id])).rows[0] as {
          status: string; km_end: string; fuel_spent: string; fuel_expense_id: string | null };
      check('L10c fechamento só anota gasolina e não cria uma segunda despesa',
        fech1.fuel_expense_id === null && t1.status === 'closed' && Number(t1.km_end) === 45080
        && Number(t1.fuel_spent) === 187.3 && t1.fuel_expense_id === null
        && (await despesasProva()) === antes + 1);

      let barrou2 = false;
      try { await closeMatrizTrip({ trip_id: trip1.trip_id, environment: ENV }, transactionPool); }
      catch (e) { barrou2 = (e as Error).message === 'trip_not_found'; }
      check('L11 fechar rota 2x barrado (trip_not_found)', barrou2);

      const trip2 = await openMatrizTrip({ courier_name: 'Maria PROVA-LOG', km_start: 100,
        order_ids: [await seedOrder({ unitId: mainUnitId })], environment: ENV }, transactionPool);
      tripIds.push(trip2.trip_id);
      const rec2 = await addMatrizTripReceipt({ trip_id: trip2.trip_id,
        bytes: fakeReceipt('RECIBO-2'), mime: 'image/jpeg', environment: ENV }, transactionPool);
      const unreadAttempt = await beginReceiptAiAttempt({ receipt_id: rec2.receipt_id,
        environment: ENV, model: 'prova-log-model', extractor_version: 'prova-v1',
        prompt_version: 'prova-p1' }, transactionPool);
      const unread = await completeReceiptAiAttempt({ attempt_id: unreadAttempt.attempt_id,
        environment: ENV, result: { status: 'unreadable',
          summary: `cupom amassado ${runMarker}` } }, transactionPool);
      check('L12a unreadable fica para revisão e NÃO lança despesa',
        unread.workflow_status === 'review_required' && (await despesasProva()) === antes + 1);
      const fech2 = await closeMatrizTrip({ trip_id: trip2.trip_id, km_end: 180,
        fuel_spent: 95.5, notes: runMarker, environment: ENV }, transactionPool);
      check('L12b fechamento sem aprovação só anota R$95,50 e NÃO lança despesa',
        fech2.fuel_expense_id === null && (await despesasProva()) === antes + 1);

      log = await getMatrizLogistica(ENV, transactionPool);
      const rec = log.rotas_recentes.find((t) => t.id === trip1.trip_id);
      check('L13 rota recente expõe sugestão + decisão humana + despesa ligada',
        !!rec && rec.receipts.length === 1 && rec.receipts[0]!.ai_status === 'parsed'
        && rec.receipts[0]!.workflow_status === 'linked' && !!rec.receipts[0]!.decision
        && rec.deliveries_count === 1);

      const trip3 = await openMatrizTrip({ courier_name: 'Rota-Fecha-Antes PROVA-LOG',
        km_start: 200, order_ids: [await seedOrder({ unitId: mainUnitId })],
        environment: ENV }, transactionPool);
      tripIds.push(trip3.trip_id);
      const rec3 = await addMatrizTripReceipt({ trip_id: trip3.trip_id,
        bytes: fakeReceipt('RECIBO-3'), mime: 'image/jpeg', environment: ENV }, transactionPool);
      const antes3 = await despesasProva();
      const fech3 = await closeMatrizTrip({ trip_id: trip3.trip_id, km_end: 260,
        fuel_spent: 120, notes: `${runMarker} fecha antes`, environment: ENV }, transactionPool);
      check('L14a fechar ANTES da leitura continua sem despesa automática',
        fech3.fuel_expense_id === null && (await despesasProva()) === antes3);
      const attempt3 = await beginReceiptAiAttempt({ receipt_id: rec3.receipt_id,
        environment: ENV, model: 'prova-log-model', extractor_version: 'prova-v1',
        prompt_version: 'prova-p1' }, transactionPool);
      await completeReceiptAiAttempt({ attempt_id: attempt3.attempt_id, environment: ENV,
        result: { status: 'suggested', category: 'combustivel', amount: 120,
          merchant: `Posto 3 ${runMarker}`, document_date: today, confidence: 0.9,
          summary: `Posto 3 ${runMarker} · R$ 120,00` } }, transactionPool);
      check('L14b leitura DEPOIS do fechamento ainda não cria dinheiro',
        (await despesasProva()) === antes3);
      const approved3 = await approveMatrizTripReceipt({ receipt_id: rec3.receipt_id,
        ai_attempt_id: attempt3.attempt_id, amount: 120, suggested_amount: 120,
        category: 'combustivel', merchant: `Posto 3 ${runMarker}`,
        document_date: today, competence_month: competenceMonth,
        payment_status: 'paid', payment_date: today, possible_duplicate_confirmed: true,
        idempotency_key: `${runMarker}-approve-3`, actor_label: 'prova-logistica',
        note: `${runMarker} aprovação depois do fechamento`, environment: ENV }, transactionPool);
      check('L14c aprovação posterior cria exatamente uma despesa e vira lastro',
        approved3.workflow_status === 'linked' && (await despesasProva()) === antes3 + 1);
      log = await getMatrizLogistica(ENV, transactionPool);
      check('L14d despesas_total da rota soma a aprovação uma vez (120, não 240)',
        Number(log.rotas_recentes.find((t) => t.id === trip3.trip_id)!.despesas_total) === 120);
    } finally {
      await client.query('ROLLBACK');
    }
    // Mantém trip1 fechada para o guard L19, agora pelo contrato novo: só anotação.
    await closeMatrizTrip({ trip_id: trip1.trip_id, km_end: 45080,
      fuel_spent: 187.3, environment: ENV });

    // ── L15: teto de comprovantes por rota (banca: anti-abuso de storage) ──
    let capped = false;
    const trip4 = await openMatrizTrip({ courier_name: 'Maria PROVA-LOG', km_start: 1, order_ids: [await seedOrder({ unitId: mainUnitId })], environment: ENV });
    tripIds.push(trip4.trip_id);
    await client.query(
      `INSERT INTO commerce.matriz_trip_receipts (environment, trip_id, mime, size_bytes, ai_status)
       SELECT $1, $2, 'image/jpeg', 10, 'skipped' FROM generate_series(1, 50)`, [ENV, trip4.trip_id]);
    try { await addMatrizTripReceipt({ trip_id: trip4.trip_id, bytes: fakeJpeg, mime: 'image/jpeg', environment: ENV }); }
    catch (e) { capped = (e as Error).message === 'receipt_limit'; }
    check('L15 51º comprovante barrado (receipt_limit)', capped);

    // ── L16: "A ROTA SE PAGOU?" só desconta dinheiro de comprovante aprovado.
    // A seção também é desfeita integralmente para não deixar decisão append-only. ──
    await client.query('BEGIN');
    try {
      const oA = await seedOrder({ unitId: mainUnitId, total: 109.9, unitCost: 60 });
      const oB = await seedOrder({ unitId: mainUnitId, qty: 2, total: 213, unitCost: 60 });
      const oC = await seedOrder({ unitId: mainUnitId, total: 109.9, unitCost: 60 });
      const oD = await seedOrder({ unitId: mainUnitId, total: 109.9 });
      const trip5 = await openMatrizTrip({ courier_name: 'Resumo PROVA-LOG', km_start: 500,
        order_ids: [oA, oB, oC, oD], environment: ENV }, transactionPool);
      tripIds.push(trip5.trip_id);
      await setMatrizDeliveryStatus({ order_id: oA, status: 'delivered', environment: ENV }, transactionPool);
      await setMatrizDeliveryStatus({ order_id: oB, status: 'delivered', environment: ENV }, transactionPool);
      await setMatrizDeliveryStatus({ order_id: oD, status: 'delivered', environment: ENV }, transactionPool);
      await failMatrizDelivery({ order_id: oC, reason: 'PROVA-LOG resumo',
        actor_label: 'prova-log', environment: ENV }, transactionPool);
      const rec5 = await addMatrizTripReceipt({ trip_id: trip5.trip_id,
        bytes: fakeReceipt('RECIBO-RESUMO'), mime: 'image/jpeg', environment: ENV }, transactionPool);
      const attempt5 = await beginReceiptAiAttempt({ receipt_id: rec5.receipt_id,
        environment: ENV, model: 'prova-log-model', extractor_version: 'prova-v1',
        prompt_version: 'prova-p1' }, transactionPool);
      await completeReceiptAiAttempt({ attempt_id: attempt5.attempt_id, environment: ENV,
        result: { status: 'suggested', amount: 35, category: 'combustivel',
          merchant: `Posto resumo ${runMarker}`, document_date: today, confidence: 0.91,
          summary: `Posto resumo ${runMarker} · R$ 35,00` } }, transactionPool);
      const approved5 = await approveMatrizTripReceipt({ receipt_id: rec5.receipt_id,
        ai_attempt_id: attempt5.attempt_id, amount: 35, suggested_amount: 35,
        category: 'combustivel', merchant: `Posto resumo ${runMarker}`,
        document_date: today, competence_month: competenceMonth,
        payment_status: 'paid', payment_date: today, possible_duplicate_confirmed: true,
        idempotency_key: `${runMarker}-approve-5`, actor_label: 'prova-logistica',
        note: `${runMarker} resumo aprovado`, environment: ENV }, transactionPool);
      const fech5 = await closeMatrizTrip({ trip_id: trip5.trip_id, km_end: 560,
        fuel_spent: 35, environment: ENV }, transactionPool);
      log = await getMatrizLogistica(ENV, transactionPool);
      const t5 = log.rotas_recentes.find((t) => t.id === trip5.trip_id);
      const rz = t5?.resumo;
      check('L16a resumo: 3 entregues (falha FORA) e frete 9,90+13+9,90 = 32,80',
        !!rz && rz.entregues === 3 && Math.abs(rz.frete_total - 32.8) < 0.005,
        `resumo=${JSON.stringify(rz)}`);
      check('L16b lucro dos pneus SÓ com custo congelado (40+80=120) + 1 item sem custo AVISADO',
        !!rz && Math.abs(rz.lucro_pneus - 120) < 0.005 && rz.itens_sem_custo === 1);
      check('L16c rota desconta os R$35 aprovados; fechamento não cria fuel_expense_id',
        fech5.fuel_expense_id === null && !!t5
        && Math.abs(Number(t5.despesas_total) - 35) < 0.005
        && t5.fuel_spent_without_approved_expense === false,
        `despesas=${t5?.despesas_total}`);
      await client.query(`UPDATE commerce.matriz_expenses SET deleted_at=now() WHERE id=$1`,
        [approved5.expense_id]);
      log = await getMatrizLogistica(ENV, transactionPool);
      const t5Removed = log.rotas_recentes.find((t) => t.id === trip5.trip_id)!;
      check('L16d despesa removida sai do resumo e ativa aviso âmbar da gasolina sem lastro',
        Number(t5Removed.despesas_total) === 0
        && t5Removed.fuel_spent_without_approved_expense === true);
    } finally {
      await client.query('ROLLBACK');
    }

    // ── L17-L20: VÍNCULO PEDIDO↔ROTA (07-03c) — pendurar em rota aberta + rota não
    // abre vazia. Decisão do dono: opção 2 (botão "pôr na rota" + trava de vazia). ──
    const oBase = await seedOrder({ unitId: mainUnitId });
    const trip6 = await openMatrizTrip({ courier_name: 'Pendura PROVA-LOG', km_start: 10, order_ids: [oBase], environment: ENV });
    tripIds.push(trip6.trip_id);
    const oPend = await seedOrder({ unitId: mainUnitId });
    const att = await attachOrderToMatrizTrip({ order_id: oPend, trip_id: trip6.trip_id, environment: ENV });
    const pendRow = (await client.query(`SELECT trip_id, delivery_status, delivery_courier FROM commerce.orders WHERE id=$1`, [oPend])).rows[0] as { trip_id: string; delivery_status: string; delivery_courier: string };
    check('L17 pendurar: entrega entra na rota aberta (trip_id + dispatched + entregador herdado)',
      att.trip_id === trip6.trip_id && pendRow.trip_id === trip6.trip_id
      && pendRow.delivery_status === 'dispatched' && pendRow.delivery_courier === 'Pendura PROVA-LOG');

    // pendurar de novo o MESMO pedido não re-amarra (trip_id IS NULL já falhou) → barra
    let barrouRepend = false;
    try { await attachOrderToMatrizTrip({ order_id: oPend, trip_id: trip6.trip_id, environment: ENV }); }
    catch (e) { barrouRepend = (e as Error).message === 'delivery_not_found'; }
    check('L17b pendurar 2x o mesmo pedido barra (já está em rota)', barrouRepend);

    // guard: pedido FORA da main (sem unit) não pendura
    let barrouGuard = false;
    try { await attachOrderToMatrizTrip({ order_id: oSemUnit, trip_id: trip6.trip_id, environment: ENV }); }
    catch (e) { barrouGuard = (e as Error).message === 'delivery_not_found'; }
    check('L18 pendurar barra pedido fora da main (delivery_not_found)', barrouGuard);

    // rota FECHADA não recebe pendurado (trip1 fechou no L10)
    const oClosed = await seedOrder({ unitId: mainUnitId });
    let barrouFechada = false;
    try { await attachOrderToMatrizTrip({ order_id: oClosed, trip_id: trip1.trip_id, environment: ENV }); }
    catch (e) { barrouFechada = (e as Error).message === 'trip_not_open'; }
    check('L19 pendurar em rota FECHADA barra (trip_not_open)', barrouFechada);

    // rota NÃO abre vazia (order_ids ausente → count 0 → rollback, nada nasce)
    let barrouVazia = false;
    try { await openMatrizTrip({ courier_name: 'Vazia PROVA-LOG', km_start: 5, environment: ENV }); }
    catch (e) { barrouVazia = (e as Error).message === 'trip_needs_delivery'; }
    const orphan = (await client.query(`SELECT count(*)::int AS n FROM commerce.matriz_delivery_trips WHERE environment=$1 AND courier_name='Vazia PROVA-LOG'`, [ENV])).rows[0] as { n: number };
    check('L20 abrir rota vazia é rejeitada (trip_needs_delivery) e NÃO deixa trip órfã',
      barrouVazia && orphan.n === 0);

    // ── L21-L24: AGENDAMENTO (07-03e) — data nasce D+1, dono remarca. Padrão =
    // created_at+1 no fuso SP, calculado na leitura (bot intocado); remarcar grava
    // a exceção; guard barra fora-da-main e entrega já fechada. ──
    const oSched = await seedOrder({ unitId: mainUnitId });
    const expectedD1 = (await client.query(`SELECT ((created_at AT TIME ZONE 'America/Sao_Paulo')::date + 1)::text AS d FROM commerce.orders WHERE id=$1`, [oSched])).rows[0] as { d: string };
    log = await getMatrizLogistica(ENV);
    const sched1 = log.abertas.find((d) => d.order_id === oSched);
    check('L21 data padrão = D+1 do pedido (scheduled_raw null, scheduled_date = created+1)',
      !!sched1 && sched1.scheduled_raw === null && sched1.scheduled_date === expectedD1.d,
      `scheduled=${sched1?.scheduled_date} esperado=${expectedD1.d}`);

    const resched = await rescheduleMatrizDelivery({ order_id: oSched, scheduled_date: '2026-12-25', environment: ENV });
    log = await getMatrizLogistica(ENV);
    const sched2 = log.abertas.find((d) => d.order_id === oSched);
    check('L22 remarcar grava a data e a leitura usa a remarcada (não o D+1)',
      resched.scheduled_date === '2026-12-25' && !!sched2 && sched2.scheduled_raw === '2026-12-25' && sched2.scheduled_date === '2026-12-25');

    let barrouResched = false;
    try { await rescheduleMatrizDelivery({ order_id: oSemUnit, scheduled_date: '2026-12-25', environment: ENV }); }
    catch (e) { barrouResched = (e as Error).message === 'delivery_not_found'; }
    check('L23 remarcar barra pedido fora da main (delivery_not_found)', barrouResched);

    let barrouReschedDone = false;
    try { await rescheduleMatrizDelivery({ order_id: oMain, scheduled_date: '2026-12-25', environment: ENV }); }
    catch (e) { barrouReschedDone = (e as Error).message === 'delivery_not_found'; }
    check('L24 remarcar entrega JÁ entregue barra (delivery_not_found)', barrouReschedDone);

    // ── L25-L27: REPORTADAS pelo entregador (0125 → auditoria 07-08) — o limbo
    // "failed SEM cancelar" tem bloco próprio e o dono DECIDE: recolocar ou confirmar. ──
    const oReport = await seedOrder({ unitId: mainUnitId, qty: 2 });
    await applyMatrizGalpaoDecrement(client, ENV, [{ productId, quantity: 2 }], true, oReport);
    const qtyAntesReport = await qtyOf();
    // o portal reporta: failed + motivo, SEM cancelar (mesmo UPDATE do reportDeliveryFailed)
    await client.query(
      `UPDATE commerce.orders SET delivery_status='failed', delivery_failure_reason='portão fechado PROVA-LOG', updated_at=now()
        WHERE id=$1 AND environment=$2`, [oReport, ENV]);
    log = await getMatrizLogistica(ENV);
    const rep = log.reportadas.find((d) => d.order_id === oReport);
    check('L25 reportada entra no bloco próprio COM o motivo (fora de abertas E finalizadas)',
      !!rep && rep.delivery_failure_reason === 'portão fechado PROVA-LOG'
      && !log.abertas.some((d) => d.order_id === oReport)
      && !log.finalizadas.some((d) => d.order_id === oReport));

    // L26: o dono DISCORDA → recoloca na fila (pending, fora de rota, motivo limpo)
    await requeueMatrizDelivery({ order_id: oReport, environment: ENV });
    log = await getMatrizLogistica(ENV);
    const req1 = (await client.query(`SELECT delivery_status, trip_id, delivery_failure_reason FROM commerce.orders WHERE id=$1`, [oReport])).rows[0] as { delivery_status: string; trip_id: string | null; delivery_failure_reason: string | null };
    check('L26 recolocar: volta pending + solta da rota + limpa motivo + reaparece nas abertas',
      req1.delivery_status === 'pending' && req1.trip_id === null && req1.delivery_failure_reason === null
      && log.abertas.some((d) => d.order_id === oReport)
      && !log.reportadas.some((d) => d.order_id === oReport));

    let barrouReq = false;
    try { await requeueMatrizDelivery({ order_id: oReport, environment: ENV }); }
    catch (e) { barrouReq = (e as Error).message === 'delivery_not_found'; }
    check('L26b recolocar de novo (já pending) barra (delivery_not_found)', barrouReq);

    // L27: reporta de novo e o dono CONFIRMA → cancela e o galpão VOLTA (+2)
    await client.query(
      `UPDATE commerce.orders SET delivery_status='failed', delivery_failure_reason='agora foi mesmo PROVA-LOG', updated_at=now()
        WHERE id=$1 AND environment=$2`, [oReport, ENV]);
    await failMatrizDelivery({ order_id: oReport, reason: 'agora foi mesmo PROVA-LOG', actor_label: 'prova-log', environment: ENV });
    log = await getMatrizLogistica(ENV);
    const conf = (await client.query(`SELECT status FROM commerce.orders WHERE id=$1`, [oReport])).rows[0] as { status: string };
    check('L27 confirmar: cancela + galpão volta (+2) + sai do bloco + entra nas finalizadas',
      conf.status === 'cancelled' && (await qtyOf()) === qtyAntesReport + 2
      && !log.reportadas.some((d) => d.order_id === oReport)
      && log.finalizadas.some((d) => d.order_id === oReport),
      `qty=${await qtyOf()} (antes=${qtyAntesReport})`);

    // ── L28: número da rota + contrato novo do fechamento sem dinheiro. ──
    const numeradas = [...log.rotas_abertas, ...log.rotas_recentes];
    check('L28a toda rota tem trip_number ROTA-XXXX e sem repetição',
      numeradas.length > 0 && numeradas.every((t) => /^ROTA-\d{4,}$/.test(t.trip_number))
      && new Set(numeradas.map((t) => t.trip_number)).size === numeradas.length,
      numeradas.map((t) => t.trip_number).join(' '));

    const fechPend = await closeMatrizTrip({ trip_id: trip6.trip_id, km_end: 60, fuel_spent: 22, environment: ENV });
    log = await getMatrizLogistica(ENV);
    const closed6 = log.rotas_recentes.find((t) => t.id === trip6.trip_id);
    check('L28b fechamento com R$22 só anota, não cria despesa e acende aviso âmbar',
      fechPend.fuel_expense_id === null && !!closed6
      && Number(closed6.fuel_spent) === 22
      && closed6.fuel_spent_without_approved_expense === true);

    console.log(`\n${fails === 0 ? '✅ LOGÍSTICA DA MATRIZ PROVADA (fila main-only + termômetro + galpão volta + IA só sugere + aprovação humana idempotente + fechamento sem dinheiro + blob + rota-se-pagou + vínculo pedido↔rota + agendamento D+1 + reportadas/decisão do dono + número da rota)' : `❌ ${fails} CASO(S) FALHARAM`}`);
  } finally {
    // As decisões novas rodam em transações revertidas. A limpeza abaixo preserva
    // compatibilidade com resíduos do contrato antigo e com os demais cenários.
    // 2º apaga blobs → receipts → trips (a FK protege a despesa referenciada — provado);
    // 3º só ENTÃO apaga as despesas capturadas.
    const expIds = tripIds.length
      ? (await client.query<{ id: string }>(
          `SELECT fuel_expense_id AS id FROM commerce.matriz_delivery_trips
            WHERE environment=$1 AND id = ANY($2::uuid[]) AND fuel_expense_id IS NOT NULL
           UNION
           SELECT ai_expense_id AS id FROM commerce.matriz_trip_receipts
            WHERE environment=$1 AND trip_id = ANY($2::uuid[]) AND ai_expense_id IS NOT NULL`,
          [ENV, tripIds])).rows.map((r) => r.id)
      : [];
    for (const id of orderIds) {
      await client.query(`UPDATE commerce.orders SET trip_id=NULL WHERE id=$1`, [id]);
    }
    if (tripIds.length) {
      await client.query(`DELETE FROM commerce.matriz_trip_receipt_blobs WHERE environment=$1 AND receipt_id IN (SELECT id FROM commerce.matriz_trip_receipts WHERE trip_id = ANY($2::uuid[]))`, [ENV, tripIds]);
      await client.query(`DELETE FROM commerce.matriz_trip_receipts WHERE environment=$1 AND trip_id = ANY($2::uuid[])`, [ENV, tripIds]);
      await client.query(`DELETE FROM commerce.matriz_delivery_trips WHERE environment=$1 AND id = ANY($2::uuid[])`, [ENV, tripIds]);
    }
    if (expIds.length) {
      await client.query(
        `DELETE FROM commerce.matriz_expenses
          WHERE environment=$1 AND id = ANY($2::uuid[])
            AND (created_by IN ('logistica-fechamento','ia-comprovante')
                 OR created_by LIKE 'comprovante:%')`, [ENV, expIds]);
    }
    for (const id of orderIds) {
      await client.query(`DELETE FROM audit.events WHERE environment=$1 AND entity_id=$2`, [ENV, id]);
      await client.query(`DELETE FROM commerce.order_items WHERE environment=$1 AND order_id=$2`, [ENV, id]);
      await client.query(`DELETE FROM commerce.orders WHERE id=$1`, [id]);
    }
    await client.query(`DELETE FROM commerce.wholesale_stock WHERE environment=$1 AND measure=$2`, [ENV, MEASURE]);
    await client.query(`DELETE FROM commerce.wholesale_stock_movements WHERE environment=$1 AND measure=$2`, [ENV, MEASURE]);
    if (productId) {
      await client.query(`DELETE FROM commerce.tire_specs WHERE environment=$1 AND product_id=$2`, [ENV, productId]);
      await client.query(`DELETE FROM commerce.products WHERE id=$1`, [productId]);
    }
    if (contactId) await client.query(`DELETE FROM core.contacts WHERE id=$1`, [contactId]);
    client.release();
    await pool.end();
  }
  process.exit(fails > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
