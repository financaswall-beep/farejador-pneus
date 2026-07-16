import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrationFile, startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('Etapa 5 — integridade de atacado, compras e financeiro', () => {
  let db: IntegrationDb;
  let sequence = 0;
  let registerSale: typeof import('../../src/admin/painel/queries-atacado-vendas.js').registerWholesaleSale;
  let registerSupplier: typeof import('../../src/admin/painel/queries-fornecedores.js').registerWholesaleSupplier;
  let registerPurchase: typeof import('../../src/admin/painel/queries-fornecedores-registro.js').registerWholesalePurchase;
  let confirmPurchase: typeof import('../../src/admin/painel/queries-fornecedores-registro.js').confirmWholesalePurchase;
  let cancelPurchase: typeof import('../../src/admin/painel/queries-fornecedores-cancel.js').cancelWholesalePurchase;
  let cancelSale: typeof import('../../src/admin/painel/queries-atacado-cancelar.js').cancelWholesaleSale;
  let settleSale: typeof import('../../src/admin/painel/queries-financeiro-integridade.js').settleWholesaleOrderPayment;
  let settlePurchase: typeof import('../../src/admin/painel/queries-financeiro-integridade.js').settleWholesalePurchasePayment;
  let createExpense: typeof import('../../src/admin/painel/queries-financeiro-integridade.js').createMatrizExpense;
  let settleExpense: typeof import('../../src/admin/painel/queries-financeiro-integridade.js').settleMatrizExpense;
  let removeExpense: typeof import('../../src/admin/painel/queries-financeiro-integridade.js').removeMatrizExpense;
  let getFinance: typeof import('../../src/admin/painel/queries-fiado-despesas.js').getWholesaleFinance;
  let getTruth: typeof import('../../src/admin/painel/queries-financeiro-verdade.js').getMatrizFinancialTruth;
  let getNotifications: typeof import('../../src/admin/painel/queries-notificacoes.js').getMatrizNotificacoes;
  let resolveOperation: typeof import('../../src/admin/painel/stage5-integrity.js').resolveIntegrityOperation;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
      CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'emergency-token',
      WHOLESALE_FINANCE: 'true', WHOLESALE_STOCK_DECREMENT: 'true',
    });
    db = await startPostgres();
    ({ registerWholesaleSale: registerSale } = await import('../../src/admin/painel/queries-atacado-vendas.js'));
    ({ registerWholesaleSupplier: registerSupplier } = await import('../../src/admin/painel/queries-fornecedores.js'));
    ({ registerWholesalePurchase: registerPurchase, confirmWholesalePurchase: confirmPurchase }
      = await import('../../src/admin/painel/queries-fornecedores-registro.js'));
    ({ cancelWholesalePurchase: cancelPurchase }
      = await import('../../src/admin/painel/queries-fornecedores-cancel.js'));
    ({ cancelWholesaleSale: cancelSale }
      = await import('../../src/admin/painel/queries-atacado-cancelar.js'));
    ({ settleWholesaleOrderPayment: settleSale, createMatrizExpense: createExpense,
      settleWholesalePurchasePayment: settlePurchase,
      settleMatrizExpense: settleExpense, removeMatrizExpense: removeExpense }
      = await import('../../src/admin/painel/queries-financeiro-integridade.js'));
    ({ getWholesaleFinance: getFinance }
      = await import('../../src/admin/painel/queries-fiado-despesas.js'));
    ({ getMatrizFinancialTruth: getTruth }
      = await import('../../src/admin/painel/queries-financeiro-verdade.js'));
    ({ getMatrizNotificacoes: getNotifications }
      = await import('../../src/admin/painel/queries-notificacoes.js'));
    ({ resolveIntegrityOperation: resolveOperation }
      = await import('../../src/admin/painel/stage5-integrity.js'));
  }, 180_000);

  afterAll(async () => { if (db) await stopPostgres(db); });

  async function fixture(options: { quantity?: number; cost?: number } = {}) {
    sequence += 1;
    const measure = `${180 + sequence}/${50 + sequence}-${10 + sequence}`;
    const product = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.products (environment,product_code,product_name,product_type)
       VALUES ('test',$1,$2,'tire') RETURNING id`,
      [`ET5-${Date.now()}-${sequence}`, `Pneu Etapa 5 ${sequence}`],
    );
    await db.pool.query(
      `INSERT INTO commerce.tire_specs
         (environment,product_id,tire_size,width_mm,aspect_ratio,rim_diameter)
       VALUES ('test',$1,$2,$3,$4,$5)`,
      [product.rows[0]!.id, measure, 180 + sequence, 50 + sequence, 10 + sequence],
    );
    if (options.quantity !== undefined) {
      await db.pool.query(
        `INSERT INTO commerce.wholesale_stock (environment,measure,quantity_on_hand,unit_cost)
         VALUES ('test',$1,$2,$3)`, [measure, options.quantity, options.cost ?? 10],
      );
    }
    const buyer = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.wholesale_customers (environment,name)
       VALUES ('test',$1) RETURNING id`, [`Comprador Etapa 5 ${sequence}`],
    );
    const supplier = await registerSupplier({
      environment: 'test', name: `Fornecedor Etapa 5 ${sequence}`,
      phone: `2199${String(sequence).padStart(6, '0')}`,
    }, db.pool);
    return { measure, buyerId: buyer.rows[0]!.id, supplierId: supplier.id };
  }

  it('vende a última unidade uma vez, bloqueia a corrida e repete o mesmo resultado', async () => {
    const f = await fixture({ quantity: 1, cost: 20 });
    const keys = [randomUUID(), randomUUID()];
    const inputs = keys.map((idempotency_key) => ({
      environment: 'test' as const, customer_id: f.buyerId, created_by: 'etapa5-venda',
      items: [{ measure: f.measure, quantity: 1, unit_price: 30.01 }], idempotency_key,
    }));
    const attempts = await Promise.allSettled(inputs.map((input) => registerSale(input, db.pool)));
    const winner = attempts.findIndex((row) => row.status === 'fulfilled');
    const loser = attempts.findIndex((row) => row.status === 'rejected');
    expect(winner).toBeGreaterThanOrEqual(0);
    expect(loser).toBeGreaterThanOrEqual(0);
    expect(String((attempts[loser] as PromiseRejectedResult).reason)).toContain('oversell');
    const first = (attempts[winner] as PromiseFulfilledResult<Awaited<ReturnType<typeof registerSale>>>).value;
    expect(await registerSale(inputs[winner]!, db.pool)).toEqual(first);
    await expect(registerSale({ ...inputs[winner]!,
      items: [{ measure: f.measure, quantity: 1, unit_price: 31.01 }] }, db.pool))
      .rejects.toThrow('idempotency_conflict');

    const state = await db.pool.query(
      `SELECT
         (SELECT quantity_on_hand FROM commerce.wholesale_stock WHERE environment='test' AND measure=$1) quantity,
         (SELECT count(*)::int FROM commerce.wholesale_orders WHERE environment='test' AND buyer_id=$2) orders,
         (SELECT count(*)::int FROM audit.events WHERE entity_id=$3 AND event_type='created') events,
         (SELECT total_amount::text FROM commerce.wholesale_orders WHERE id=$3) header_total,
         (SELECT sum(line_total)::text FROM commerce.wholesale_order_items WHERE order_id=$3) item_total,
         (SELECT count(*)::int FROM commerce.wholesale_stock_movements
           WHERE source='venda_atacado' AND ref=$3::text) movements`,
      [f.measure, f.buyerId, first.order_id],
    );
    expect(state.rows[0]).toEqual({ quantity: 0, orders: 1, events: 1,
      header_total: '30.01', item_total: '30.01', movements: 1 });
  });

  it('recupera no servidor uma criacao concluida depois de resposta perdida', async () => {
    const f = await fixture({ quantity: 1, cost: 8 });
    const idempotencyKey = randomUUID();
    const sale = await registerSale({ environment: 'test', customer_id: f.buyerId,
      created_by: 'etapa5-recovery', idempotency_key: idempotencyKey,
      items: [{ measure: f.measure, quantity: 1, unit_price: 12.34 }] }, db.pool);
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await expect(resolveOperation(client, { environment: 'test', domain: 'wholesale_sale.create',
        idempotencyKey })).resolves.toMatchObject({ status: 'completed',
        entity_id: sale.order_id, result: sale });
      await expect(resolveOperation(client, { environment: 'test', domain: 'wholesale_sale.create',
        idempotencyKey: randomUUID() })).resolves.toEqual({ status: 'missing' });
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });

  it('bloqueia cancelamento de venda sem filme sem alterar pedido nem estoque', async () => {
    const f = await fixture({ quantity: 2, cost: 10 });
    const sale = await registerSale({ environment: 'test', customer_id: f.buyerId,
      created_by: 'etapa5-sem-filme', idempotency_key: randomUUID(),
      items: [{ measure: f.measure, quantity: 1, unit_price: 20 }] }, db.pool);
    await db.pool.query(
      `DELETE FROM commerce.wholesale_stock_movements
        WHERE environment='test' AND source='venda_atacado' AND ref=$1`, [sale.order_id]);
    await expect(cancelSale({ order_id: sale.order_id, cancelled_by: 'etapa5-sem-filme',
      reason: 'venda antiga', environment: 'test', idempotency_key: randomUUID() }, db.pool))
      .rejects.toThrow('sale_stock_history_missing');
    const state = await db.pool.query(
      `SELECT o.status,s.quantity_on_hand
         FROM commerce.wholesale_orders o
         JOIN commerce.wholesale_stock s ON s.environment=o.environment AND s.measure=$2
        WHERE o.id=$1`, [sale.order_id, f.measure]);
    expect(state.rows[0]).toEqual({ status: 'confirmed', quantity_on_hand: 1 });
  });

  it('cancela filme parcial devolvendo apenas estoque comprovado e expondo a lacuna', async () => {
    const filmed = await fixture({ quantity: 2, cost: 10 });
    const missing = await fixture({ quantity: 2, cost: 10 });
    const sale = await registerSale({ environment: 'test', customer_id: filmed.buyerId,
      created_by: 'etapa5-filme-parcial', idempotency_key: randomUUID(),
      items: [
        { measure: filmed.measure, quantity: 1, unit_price: 20 },
        { measure: missing.measure, quantity: 1, unit_price: 21 },
      ] }, db.pool);
    await db.pool.query(
      `DELETE FROM commerce.wholesale_stock_movements
        WHERE environment='test' AND source='venda_atacado' AND ref=$1 AND measure=$2`,
      [sale.order_id, missing.measure]);
    const result = await cancelSale({ order_id: sale.order_id, cancelled_by: 'etapa5-filme-parcial',
      reason: 'venda antiga parcial', environment: 'test', idempotency_key: randomUUID() }, db.pool);
    expect(result.stock_returned).toEqual([{ measure: filmed.measure, quantity: 1 }]);
    expect(result.stock_unverified).toEqual([{ measure: missing.measure, quantity: 1 }]);
    const state = await db.pool.query(
      `SELECT measure,quantity_on_hand FROM commerce.wholesale_stock
        WHERE environment='test' AND measure=ANY($1::text[]) ORDER BY measure`,
      [[filmed.measure, missing.measure]]);
    expect(Object.fromEntries(state.rows.map((row) => [row.measure, row.quantity_on_hand])))
      .toEqual({ [filmed.measure]: 2, [missing.measure]: 1 });
  });

  it('faz rollback completo após falha na baixa e permite retry da mesma chave', async () => {
    const f = await fixture({ quantity: 2, cost: 7.77 });
    const idempotencyKey = randomUUID();
    const input = { environment: 'test' as const, customer_id: f.buyerId,
      created_by: 'etapa5-falha-intermediaria', idempotency_key: idempotencyKey,
      items: [{ measure: f.measure, quantity: 1, unit_price: 11.11 }] };
    await db.pool.query(`
      CREATE OR REPLACE FUNCTION commerce.stage5_force_stock_failure()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'stage5_forced_stock_failure'; END $$;
      CREATE TRIGGER stage5_force_stock_failure_trigger
      BEFORE UPDATE ON commerce.wholesale_stock
      FOR EACH ROW EXECUTE FUNCTION commerce.stage5_force_stock_failure();
    `);
    try {
      await expect(registerSale(input, db.pool)).rejects.toThrow('stage5_forced_stock_failure');
    } finally {
      await db.pool.query(`
        DROP TRIGGER IF EXISTS stage5_force_stock_failure_trigger ON commerce.wholesale_stock;
        DROP FUNCTION IF EXISTS commerce.stage5_force_stock_failure();
      `);
    }
    const rolledBack = await db.pool.query(
      `SELECT
         (SELECT quantity_on_hand FROM commerce.wholesale_stock
           WHERE environment='test' AND measure=$1) quantity,
         (SELECT count(*)::int FROM commerce.wholesale_orders
           WHERE environment='test' AND created_by='etapa5-falha-intermediaria') orders,
         (SELECT count(*)::int FROM audit.operation_idempotency
           WHERE environment='test' AND idempotency_key=$2) operations,
         (SELECT count(*)::int FROM audit.events
           WHERE environment='test' AND actor_label='etapa5-falha-intermediaria') events`,
      [f.measure, idempotencyKey],
    );
    expect(rolledBack.rows[0]).toEqual({ quantity: 2, orders: 0, operations: 0, events: 0 });

    const retry = await registerSale(input, db.pool);
    const committed = await db.pool.query(
      `SELECT o.total_amount::text AS header_total,sum(i.line_total)::text AS item_total,
              (SELECT quantity_on_hand FROM commerce.wholesale_stock
                WHERE environment='test' AND measure=$2) quantity
         FROM commerce.wholesale_orders o
         JOIN commerce.wholesale_order_items i ON i.order_id=o.id
        WHERE o.id=$1 GROUP BY o.id`, [retry.order_id, f.measure]);
    expect(committed.rows[0]).toEqual({ header_total: '11.11', item_total: '11.11', quantity: 1 });
  });

  it('mantém compra pendente fora do estoque e confirma exatamente uma vez', async () => {
    const f = await fixture();
    const createKey = randomUUID();
    const input = {
      environment: 'test' as const, supplier_id: f.supplierId, created_by: 'etapa5-compra',
      receipt_status: 'pending' as const, payment_status: 'pending' as const,
      items: [{ measure: f.measure, quantity: 2, unit_cost: 12.34 }], idempotency_key: createKey,
    };
    const pending = await registerPurchase(input, db.pool);
    expect(await registerPurchase(input, db.pool)).toEqual(pending);
    expect(pending).toMatchObject({ status: 'pending', stock_applied: false, total_amount: '24.68' });
    expect((await db.pool.query(
      `SELECT count(*)::int AS count FROM commerce.wholesale_stock
        WHERE environment='test' AND measure=$1`, [f.measure])).rows[0].count).toBe(0);

    const confirmKey = randomUUID();
    const confirmInput = { purchase_id: pending.purchase_id, confirmed_by: 'etapa5-recebimento',
      environment: 'test' as const, idempotency_key: confirmKey };
    const confirmed = await confirmPurchase(confirmInput, db.pool);
    expect(await confirmPurchase(confirmInput, db.pool)).toEqual(confirmed);
    await expect(confirmPurchase({ ...confirmInput, idempotency_key: randomUUID() }, db.pool))
      .rejects.toThrow('purchase_already_confirmed');
    const stock = await db.pool.query(
      `SELECT quantity_on_hand,unit_cost FROM commerce.wholesale_stock
        WHERE environment='test' AND measure=$1`, [f.measure]);
    expect(stock.rows[0]).toEqual({ quantity_on_hand: 2, unit_cost: '12.34' });
  });

  it('mantem compra em transito no dinheiro sem coloca-la no estoque', async () => {
    const f = await fixture();
    const beforeTruth = await getTruth('test', db.pool);
    const beforeNotifications = await getNotifications('test', db.pool);
    const pending = await registerPurchase({ environment: 'test', supplier_id: f.supplierId,
      created_by: 'etapa5-dinheiro-pendente', receipt_status: 'pending',
      payment_status: 'pending', due_date: '2020-01-01', idempotency_key: randomUUID(),
      items: [{ measure: f.measure, quantity: 2, unit_cost: 12.34 }] }, db.pool);

    const finance = await getFinance('test', db.pool);
    const pendingTruth = await getTruth('test', db.pool);
    const pendingNotifications = await getNotifications('test', db.pool);
    const beforePurchaseOrigin = beforeTruth.conciliacao.origens.find((row) => row.origem === 'compras')!;
    const pendingPurchaseOrigin = pendingTruth.conciliacao.origens.find((row) => row.origem === 'compras')!;
    expect(finance.payables.some((row) => row.id === pending.purchase_id)).toBe(true);
    expect(Number(pendingTruth.posicao.a_pagar) - Number(beforeTruth.posicao.a_pagar)).toBeCloseTo(24.68, 2);
    expect(Number(pendingPurchaseOrigin.origem_total) - Number(beforePurchaseOrigin.origem_total)).toBeCloseTo(24.68, 2);
    expect(Number(pendingPurchaseOrigin.contabilizado) - Number(beforePurchaseOrigin.contabilizado)).toBeCloseTo(24.68, 2);
    expect(pendingNotifications.a_pagar_vencido.count - beforeNotifications.a_pagar_vencido.count).toBe(1);
    expect(Number(pendingNotifications.a_pagar_vencido.total)
      - Number(beforeNotifications.a_pagar_vencido.total)).toBeCloseTo(24.68, 2);

    await settlePurchase(pending.purchase_id, 'test', db.pool,
      { idempotency_key: randomUUID(), actor_label: 'etapa5-dinheiro-pendente' });
    const paidTruth = await getTruth('test', db.pool);
    const paidFinance = await getFinance('test', db.pool);
    expect(Number(paidTruth.caixa.pagamentos.compras)
      - Number(beforeTruth.caixa.pagamentos.compras)).toBeCloseTo(24.68, 2);
    expect(Number(paidTruth.posicao.a_pagar)).toBeCloseTo(Number(beforeTruth.posicao.a_pagar), 2);
    expect(paidFinance.payables.some((row) => row.id === pending.purchase_id)).toBe(false);
    const state = await db.pool.query(
      `SELECT p.status,p.payment_status,p.stock_applied,
              (SELECT count(*)::int FROM commerce.wholesale_stock s
                WHERE s.environment=p.environment AND s.measure=$2) AS stock_rows
         FROM commerce.wholesale_purchases p WHERE p.id=$1`, [pending.purchase_id, f.measure]);
    expect(state.rows[0]).toEqual({ status: 'pending', payment_status: 'paid',
      stock_applied: false, stock_rows: 0 });
  });

  it('recusa fornecedor duplicado por nome, documento ou telefone normalizado', async () => {
    await registerSupplier({ environment: 'test', name: 'Ágil Pneus Ltda.',
      document: '12.345.678/0001-90', phone: '(21) 99999-1111' }, db.pool);
    await expect(registerSupplier({ environment: 'test', name: 'agil---pneus ltda',
      document: '98.765.432/0001-10', phone: '21999992222' }, db.pool)).rejects.toMatchObject({ code: '23505' });
    await expect(registerSupplier({ environment: 'test', name: 'Outro Documento',
      document: '12345678000190', phone: '21999993333' }, db.pool)).rejects.toMatchObject({ code: '23505' });
    await expect(registerSupplier({ environment: 'test', name: 'Outro Telefone',
      document: '98.765.432/0001-11', phone: '21 99999-1111' }, db.pool)).rejects.toMatchObject({ code: '23505' });
  });

  it('restaura custo e saldo exatos; após consumo bloqueia sem mutação parcial', async () => {
    const exact = await fixture({ quantity: 5, cost: 10 });
    const purchase = await registerPurchase({ environment: 'test', supplier_id: exact.supplierId,
      created_by: 'etapa5-cancel', receipt_status: 'received', idempotency_key: randomUUID(),
      items: [{ measure: exact.measure, quantity: 2, unit_cost: 20 }] }, db.pool);
    const cancelInput = { purchase_id: purchase.purchase_id, cancelled_by: 'etapa5-cancel',
      reason: 'lançamento duplicado', environment: 'test' as const, idempotency_key: randomUUID() };
    const cancelled = await cancelPurchase(cancelInput, db.pool);
    expect(await cancelPurchase(cancelInput, db.pool)).toEqual(cancelled);
    expect((await db.pool.query(
      `SELECT quantity_on_hand,unit_cost FROM commerce.wholesale_stock
        WHERE environment='test' AND measure=$1`, [exact.measure])).rows[0])
      .toEqual({ quantity_on_hand: 5, unit_cost: '10.00' });

    const consumed = await fixture({ quantity: 2, cost: 10 });
    const unsafe = await registerPurchase({ environment: 'test', supplier_id: consumed.supplierId,
      created_by: 'etapa5-cancel', receipt_status: 'received', idempotency_key: randomUUID(),
      items: [{ measure: consumed.measure, quantity: 3, unit_cost: 20 }] }, db.pool);
    await registerSale({ environment: 'test', customer_id: consumed.buyerId, created_by: 'etapa5-consumo',
      items: [{ measure: consumed.measure, quantity: 1, unit_price: 30 }],
      idempotency_key: randomUUID() }, db.pool);
    await expect(cancelPurchase({ purchase_id: unsafe.purchase_id, cancelled_by: 'etapa5-cancel',
      reason: 'estoque consumido', environment: 'test', idempotency_key: randomUUID() }, db.pool))
      .rejects.toThrow('purchase_stock_consumed');
    const unchanged = await db.pool.query(
      `SELECT p.status,s.quantity_on_hand,s.unit_cost
         FROM commerce.wholesale_purchases p
         JOIN commerce.wholesale_stock s ON s.environment=p.environment AND s.measure=$2
        WHERE p.id=$1`, [unsafe.purchase_id, consumed.measure]);
    expect(unchanged.rows[0]).toEqual({ status: 'confirmed', quantity_on_hand: 4, unit_cost: '16.00' });
  });

  it('não aplica estoque ao cancelar pendência', async () => {
    const f = await fixture();
    const pending = await registerPurchase({ environment: 'test', supplier_id: f.supplierId,
      created_by: 'etapa5-pendente', receipt_status: 'pending', idempotency_key: randomUUID(),
      items: [{ measure: f.measure, quantity: 7, unit_cost: 9.99 }] }, db.pool);
    const cancelInput = { purchase_id: pending.purchase_id, cancelled_by: 'etapa5-pendente',
      reason: 'mercadoria não recebida', environment: 'test' as const, idempotency_key: randomUUID() };
    const first = await cancelPurchase(cancelInput, db.pool);
    expect(await cancelPurchase(cancelInput, db.pool)).toEqual(first);
    const state = await db.pool.query(
      `SELECT p.status,p.stock_applied,
              (SELECT count(*)::int FROM commerce.wholesale_stock s
                WHERE s.environment=p.environment AND s.measure=$2) stock_rows
         FROM commerce.wholesale_purchases p WHERE p.id=$1`, [pending.purchase_id, f.measure]);
    expect(state.rows[0]).toEqual({ status: 'cancelled', stock_applied: false, stock_rows: 0 });
  });

  it('repete pagamentos/despesas e preserva ambiente, operador e motivo', async () => {
    const f = await fixture({ quantity: 2, cost: 5 });
    const sale = await registerSale({ environment: 'test', customer_id: f.buyerId,
      created_by: 'etapa5-financeiro', payment_status: 'pending', due_date: '2026-08-01',
      items: [{ measure: f.measure, quantity: 1, unit_price: 10.01 }],
      idempotency_key: randomUUID() }, db.pool);
    const payOptions = { idempotency_key: randomUUID(), actor_label: 'Operador Etapa 5' };
    const paid = await settleSale(sale.order_id, 'test', db.pool, payOptions);
    expect(await settleSale(sale.order_id, 'test', db.pool, payOptions)).toEqual(paid);
    await expect(settleSale(sale.order_id, 'test', db.pool,
      { ...payOptions, idempotency_key: randomUUID() })).rejects.toThrow('receivable_not_found');

    const expenseKey = randomUUID();
    const expenseInput = { environment: 'test' as const, category: 'outros', amount: 10.01,
      description: 'Despesa Etapa 5', payment_status: 'pending' as const,
      created_by: 'Operador Etapa 5', idempotency_key: expenseKey };
    const expense = await createExpense(expenseInput, db.pool);
    expect(await createExpense(expenseInput, db.pool)).toEqual(expense);
    await expect(createExpense({ ...expenseInput, amount: 10.02 }, db.pool))
      .rejects.toThrow('idempotency_conflict');
    const expensePay = { idempotency_key: randomUUID(), actor_label: 'Operador Etapa 5' };
    const settled = await settleExpense(expense.id, 'test', db.pool, expensePay);
    expect(await settleExpense(expense.id, 'test', db.pool, expensePay)).toEqual(settled);

    const removable = await createExpense({ environment: 'test', category: 'outros', amount: 3.33,
      description: 'Remover com trilha', created_by: 'Operador Etapa 5',
      idempotency_key: randomUUID() }, db.pool);
    await expect(removeExpense(removable.id, 'test', db.pool,
      { idempotency_key: randomUUID(), actor_label: 'Operador Etapa 5' })).rejects.toThrow('reason_required');
    const removeOptions = { idempotency_key: randomUUID(), actor_label: 'Operador Etapa 5',
      reason: 'lançamento de teste duplicado' };
    const removed = await removeExpense(removable.id, 'test', db.pool, removeOptions);
    expect(await removeExpense(removable.id, 'test', db.pool, removeOptions)).toEqual(removed);
    const trail = await db.pool.query(
      `SELECT e.deleted_by,e.delete_reason,
              (SELECT count(*)::int FROM audit.events a
                WHERE a.entity_id=e.id AND a.actor_label='Operador Etapa 5') audit_events
         FROM commerce.matriz_expenses e WHERE e.id=$1`, [removable.id]);
    expect(trail.rows[0]).toEqual({ deleted_by: 'Operador Etapa 5',
      delete_reason: 'lançamento de teste duplicado', audit_events: 2 });

    const sharedKey = randomUUID();
    const inTest = await createExpense({ environment: 'test', category: 'outros', amount: 1,
      created_by: 'ambiente', idempotency_key: sharedKey }, db.pool);
    const inProd = await createExpense({ environment: 'prod', category: 'outros', amount: 1,
      created_by: 'ambiente', idempotency_key: sharedKey }, db.pool);
    expect(inProd.id).not.toBe(inTest.id);
  });

  it('não concede as tabelas da Matriz à role do parceiro', async () => {
    await db.pool.query(`
      GRANT ALL PRIVILEGES ON TABLE
        audit.operation_idempotency,
        commerce.wholesale_suppliers,
        commerce.wholesale_purchases,
        commerce.matriz_expenses
      TO farejador_partner_app;
      GRANT SELECT (name), UPDATE (phone), REFERENCES (id)
        ON TABLE commerce.wholesale_suppliers TO farejador_partner_app;
    `);
    await applyMigrationFile(db.pool, '0136_wholesale_purchase_integrity.sql');
    const permissions = await db.pool.query(
      `WITH tables(name) AS (VALUES
         ('audit.operation_idempotency'),('commerce.wholesale_suppliers'),
         ('commerce.wholesale_purchases'),('commerce.matriz_expenses')
       ), table_privileges(name) AS (VALUES
         ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),
         ('REFERENCES'),('TRIGGER'),('MAINTAIN')
       ), column_privileges(name) AS (VALUES
         ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')
       )
       SELECT has_table_privilege('farejador_partner_app',t.name,p.name) AS allowed
         FROM tables t CROSS JOIN table_privileges p
       UNION ALL
       SELECT has_any_column_privilege('farejador_partner_app',t.name,p.name) AS allowed
         FROM tables t CROSS JOIN column_privileges p`,
    );
    expect(permissions.rows.every((row) => row.allowed === false)).toBe(true);
  });
});
