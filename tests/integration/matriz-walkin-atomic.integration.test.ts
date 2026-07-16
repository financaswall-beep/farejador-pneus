import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { RegisterWalkinOrderInput } from '../../src/admin/painel/queries-pedidos.js';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('venda walk-in atomica da Matriz', () => {
  let db: IntegrationDb;
  let mainUnitId: string;
  let sellerId: string;
  let sequence = 0;
  let registerWalkinOrder: typeof import('../../src/admin/painel/queries-pedidos-acoes.js').registerWalkinOrder;
  let cancelManualOrder: typeof import('../../src/admin/painel/queries-pedidos-acoes.js').cancelManualOrder;
  let getVarejoResumo: typeof import('../../src/admin/painel/queries-galpao.js').getVarejoResumo;
  let addWholesaleStockEntry: typeof import('../../src/admin/painel/queries-galpao.js').addWholesaleStockEntry;
  let setWholesaleStock: typeof import('../../src/admin/painel/queries-galpao.js').setWholesaleStock;
  let getMatrizFinanceiroVisao: typeof import('../../src/admin/painel/queries-financeiro-visao.js').getMatrizFinanceiroVisao;
  let getMatrizStockReconciliation: typeof import('../../src/admin/painel/queries-stock-reconciliation.js').getMatrizStockReconciliation;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      FAREJADOR_ENV: 'test',
      DATABASE_URL: 'postgres://test',
      CHATWOOT_HMAC_SECRET: 'test-secret',
      ADMIN_AUTH_TOKEN: 'emergency-token',
    });
    db = await startPostgres();
    ({ registerWalkinOrder, cancelManualOrder } = await import('../../src/admin/painel/queries-pedidos-acoes.js'));
    ({ getVarejoResumo, addWholesaleStockEntry, setWholesaleStock } = await import('../../src/admin/painel/queries-galpao.js'));
    ({ getMatrizFinanceiroVisao } = await import('../../src/admin/painel/queries-financeiro-visao.js'));
    ({ getMatrizStockReconciliation } = await import('../../src/admin/painel/queries-stock-reconciliation.js'));

    await db.pool.query(
      `INSERT INTO core.units (environment, slug, name, is_active)
       VALUES ('test', 'main', 'Matriz de integracao', true)
       ON CONFLICT (environment, slug) DO UPDATE SET is_active = true`,
    );
    const unit = await db.pool.query<{ id: string }>(
      `SELECT id FROM core.units WHERE environment='test' AND slug='main'`,
    );
    mainUnitId = unit.rows[0]!.id;

    const person = await db.pool.query<{ id: string }>(
      `INSERT INTO network.partner_people (environment, username)
       VALUES ('test', $1) RETURNING id`,
      [`walkin-seller-${Date.now()}`],
    );
    const seller = await db.pool.query<{ id: string }>(
      `INSERT INTO network.matriz_collaborators
         (environment, person_id, display_name, job, job_title, work_area, created_by)
       VALUES ('test', $1, 'Vendedor Integracao', 'vendedor', 'Vendedor', 'sales', 'vitest')
       RETURNING id`,
      [person.rows[0]!.id],
    );
    sellerId = seller.rows[0]!.id;
  }, 180_000);

  afterAll(async () => { if (db) await stopPostgres(db); });

  function key(prefix: string): string {
    sequence += 1;
    return `${prefix}-${Date.now()}-${sequence}`;
  }

  async function createProduct(options: {
    quantity?: number;
    cost?: number;
    withSpec?: boolean;
    withStock?: boolean;
  } = {}): Promise<{ productId: string; measure: string }> {
    const suffix = key('produto');
    const measure = `${110 + sequence}/${50 + sequence}-${12 + sequence}`;
    const product = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.products
         (environment, product_code, product_name, product_type)
       VALUES ('test', $1, $2, 'tire') RETURNING id`,
      [`WALKIN-${suffix}`, `Pneu ${suffix}`],
    );
    const productId = product.rows[0]!.id;
    if (options.withSpec !== false) {
      await db.pool.query(
        `INSERT INTO commerce.tire_specs (environment, product_id, tire_size)
         VALUES ('test', $1, $2)`,
        [productId, measure],
      );
    }
    if (options.withStock !== false) {
      await db.pool.query(
        `INSERT INTO commerce.wholesale_stock
           (environment, measure, quantity_on_hand, unit_cost)
         VALUES ('test', $1, $2, $3)`,
        [measure, options.quantity ?? 5, options.cost ?? 40],
      );
    }
    return { productId, measure };
  }

  function saleInput(
    productId: string,
    idempotencyKey: string,
    options: { quantity?: number; customerName?: string; seller?: boolean } = {},
  ): RegisterWalkinOrderInput {
    return {
      environment: 'test',
      customer_name: options.customerName ?? `Cliente ${idempotencyKey}`,
      customer_phone: null,
      unit_id: mainUnitId,
      items: [{ product_id: productId, quantity: options.quantity ?? 1, unit_price: 120, discount_amount: 10 }],
      payment_method: 'pix',
      fulfillment_mode: 'pickup',
      delivery_address: null,
      actor_label: 'Vitest Vendedor',
      seller_collaborator_id: options.seller === false ? null : sellerId,
      idempotency_key: idempotencyKey,
      source_tag: 'walkin_balcao',
    };
  }

  async function countOrders(idempotencyKeys: string[]): Promise<number> {
    const result = await db.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM commerce.orders
        WHERE idempotency_key = ANY($1::text[])`,
      [idempotencyKeys],
    );
    return result.rows[0]!.count;
  }

  it('confirma pedido, itens, vendedor, custo, estoque, movimento, cliente e Financeiro juntos', async () => {
    const fixture = await createProduct({ quantity: 5, cost: 40 });
    const idempotencyKey = key('normal');
    const before = await getVarejoResumo('tudo', 'test', db.pool);

    const result = await registerWalkinOrder(
      saleInput(fixture.productId, idempotencyKey, { quantity: 2 }),
      db.pool,
    );

    const order = await db.pool.query<{
      status: string;
      total_amount: string;
      seller_collaborator_id: string;
      closed_at: Date | null;
      matriz_unit_cost: string;
      item_quantity: number;
      customer_name: string;
    }>(
      `SELECT o.status, o.total_amount, o.seller_collaborator_id, o.closed_at,
              oi.matriz_unit_cost, oi.quantity AS item_quantity, c.name AS customer_name
         FROM commerce.orders o
         JOIN commerce.order_items oi ON oi.order_id=o.id AND oi.environment=o.environment
         JOIN commerce.customers c ON c.id=o.customer_id AND c.environment=o.environment
        WHERE o.id=$1`,
      [result.order_id],
    );
    expect(order.rows[0]).toMatchObject({
      status: 'confirmed',
      total_amount: '230.00',
      seller_collaborator_id: sellerId,
      matriz_unit_cost: '40',
      item_quantity: 2,
      customer_name: `Cliente ${idempotencyKey}`,
    });
    expect(order.rows[0]!.closed_at).toBeInstanceOf(Date);

    const stock = await db.pool.query<{ quantity: number }>(
      `SELECT quantity_on_hand AS quantity FROM commerce.wholesale_stock
        WHERE environment='test' AND measure=$1`,
      [fixture.measure],
    );
    expect(stock.rows[0]!.quantity).toBe(3);

    const movement = await db.pool.query<{ qty_delta: number; source: string; ref: string }>(
      `SELECT qty_delta, source, ref
         FROM commerce.wholesale_stock_movements
        WHERE environment='test' AND measure=$1 AND ref=$2`,
      [fixture.measure, result.order_id],
    );
    expect(movement.rows).toEqual([{ qty_delta: -2, source: 'varejo', ref: result.order_id }]);

    const audit = await db.pool.query<{ event_type: string }>(
      `SELECT event_type FROM audit.events
        WHERE environment='test' AND entity_id=$1 ORDER BY event_type`,
      [result.order_id],
    );
    expect(audit.rows.map((row) => row.event_type)).toEqual([
      'matriz_galpao_decrement',
      'walkin_order_created',
    ]);

    const after = await getVarejoResumo('tudo', 'test', db.pool);
    expect(Number(after.faturamento) - Number(before.faturamento)).toBe(230);
    expect(Number(after.custo_total) - Number(before.custo_total)).toBe(80);
    expect(Number(after.lucro_total) - Number(before.lucro_total)).toBe(150);
    expect(after.vendas_count - before.vendas_count).toBe(1);
    expect(after.itens_sem_custo - before.itens_sem_custo).toBe(0);
  });

  it('rejeita produto sem medida e nao cria pedido nem cliente', async () => {
    const fixture = await createProduct({ withSpec: false, withStock: false });
    const idempotencyKey = key('sem-medida');
    const input = saleInput(fixture.productId, idempotencyKey);

    await expect(registerWalkinOrder(input, db.pool)).rejects.toThrow('walkin_measure_not_found');
    expect(await countOrders([idempotencyKey])).toBe(0);
    const customers = await db.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM commerce.customers WHERE name=$1`,
      [input.customer_name],
    );
    expect(customers.rows[0]!.count).toBe(0);
  });

  it('rejeita custo zero/desconhecido sem registrar venda', async () => {
    const fixture = await createProduct({ quantity: 3, cost: 0 });
    const idempotencyKey = key('sem-custo');

    await expect(registerWalkinOrder(saleInput(fixture.productId, idempotencyKey), db.pool))
      .rejects.toThrow('walkin_cost_missing');
    expect(await countOrders([idempotencyKey])).toBe(0);
  });

  it('rejeita estoque insuficiente sem clampar o saldo', async () => {
    const fixture = await createProduct({ quantity: 1, cost: 40 });
    const idempotencyKey = key('insuficiente');

    await expect(registerWalkinOrder(
      saleInput(fixture.productId, idempotencyKey, { quantity: 2 }),
      db.pool,
    )).rejects.toThrow('walkin_stock_insufficient');
    expect(await countOrders([idempotencyKey])).toBe(0);
    const stock = await db.pool.query<{ quantity: number }>(
      `SELECT quantity_on_hand AS quantity FROM commerce.wholesale_stock
        WHERE environment='test' AND measure=$1`,
      [fixture.measure],
    );
    expect(stock.rows[0]!.quantity).toBe(1);
  });

  it('permite somente uma de duas vendas concorrentes da ultima unidade', async () => {
    const fixture = await createProduct({ quantity: 1, cost: 40 });
    const keys = [key('ultima-a'), key('ultima-b')];
    const settled = await Promise.allSettled(keys.map((idempotencyKey) =>
      registerWalkinOrder(saleInput(fixture.productId, idempotencyKey), db.pool)));

    expect(settled.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    const failure = settled.find((entry) => entry.status === 'rejected');
    expect(failure).toMatchObject({ status: 'rejected' });
    expect(String((failure as PromiseRejectedResult).reason)).toContain('walkin_stock_insufficient');
    expect(await countOrders(keys)).toBe(1);
    const stock = await db.pool.query<{ quantity: number }>(
      `SELECT quantity_on_hand AS quantity FROM commerce.wholesale_stock
        WHERE environment='test' AND measure=$1`,
      [fixture.measure],
    );
    expect(stock.rows[0]!.quantity).toBe(0);
  });

  it('faz rollback completo quando falha depois de inserir o pedido', async () => {
    const fixture = await createProduct({ quantity: 2, cost: 40 });
    const idempotencyKey = key('falha-item');
    const input = saleInput(fixture.productId, idempotencyKey);
    await installFailureTrigger(db.pool, {
      functionName: 'walkin_fail_after_order',
      triggerName: 'walkin_fail_after_order_trigger',
      table: 'commerce.order_items',
      timing: 'BEFORE INSERT',
      message: 'walkin_test_after_order',
    });
    try {
      await expect(registerWalkinOrder(input, db.pool)).rejects.toThrow('walkin_test_after_order');
    } finally {
      await removeFailureTrigger(db.pool, 'commerce.order_items', 'walkin_fail_after_order_trigger', 'walkin_fail_after_order');
    }

    expect(await countOrders([idempotencyKey])).toBe(0);
    const customers = await db.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM commerce.customers WHERE name=$1`,
      [input.customer_name],
    );
    expect(customers.rows[0]!.count).toBe(0);
  });

  it('faz rollback de pedido, itens e cliente quando a baixa falha', async () => {
    const fixture = await createProduct({ quantity: 2, cost: 40 });
    const idempotencyKey = key('falha-baixa');
    const input = saleInput(fixture.productId, idempotencyKey);
    await installFailureTrigger(db.pool, {
      functionName: 'walkin_fail_stock',
      triggerName: 'walkin_fail_stock_trigger',
      table: 'commerce.wholesale_stock',
      timing: 'BEFORE UPDATE',
      message: 'walkin_test_stock_failure',
    });
    try {
      await expect(registerWalkinOrder(input, db.pool)).rejects.toThrow('walkin_test_stock_failure');
    } finally {
      await removeFailureTrigger(db.pool, 'commerce.wholesale_stock', 'walkin_fail_stock_trigger', 'walkin_fail_stock');
    }

    expect(await countOrders([idempotencyKey])).toBe(0);
    const state = await db.pool.query<{ quantity: number; customers: number }>(
      `SELECT
         (SELECT quantity_on_hand FROM commerce.wholesale_stock
           WHERE environment='test' AND measure=$1) AS quantity,
         (SELECT count(*)::int FROM commerce.customers WHERE name=$2) AS customers`,
      [fixture.measure, input.customer_name],
    );
    expect(state.rows[0]).toEqual({ quantity: 2, customers: 0 });
  });

  it('retry devolve o pedido original sem segunda baixa', async () => {
    const fixture = await createProduct({ quantity: 4, cost: 40 });
    const idempotencyKey = key('retry');
    const input = saleInput(fixture.productId, idempotencyKey);

    const first = await registerWalkinOrder(input, db.pool);
    const retry = await registerWalkinOrder(input, db.pool);

    expect(retry.order_id).toBe(first.order_id);
    expect(await countOrders([idempotencyKey])).toBe(1);
    const state = await db.pool.query<{ quantity: number; decrements: number }>(
      `SELECT
         (SELECT quantity_on_hand FROM commerce.wholesale_stock
           WHERE environment='test' AND measure=$1) AS quantity,
         (SELECT count(*)::int FROM audit.events
           WHERE entity_id=$2 AND event_type='matriz_galpao_decrement') AS decrements`,
      [fixture.measure, first.order_id],
    );
    expect(state.rows[0]).toEqual({ quantity: 3, decrements: 1 });
  });

  it('duplo clique concorrente gera um pedido e uma baixa', async () => {
    const fixture = await createProduct({ quantity: 1, cost: 40 });
    const idempotencyKey = key('duplo-clique');
    const input = saleInput(fixture.productId, idempotencyKey);

    const [a, b] = await Promise.all([
      registerWalkinOrder(input, db.pool),
      registerWalkinOrder(input, db.pool),
    ]);

    expect(a.order_id).toBe(b.order_id);
    expect(await countOrders([idempotencyKey])).toBe(1);
    const stock = await db.pool.query<{ quantity: number }>(
      `SELECT quantity_on_hand AS quantity FROM commerce.wholesale_stock
        WHERE environment='test' AND measure=$1`,
      [fixture.measure],
    );
    expect(stock.rows[0]!.quantity).toBe(0);
  });

  it('cancelamento devolve exatamente a quantidade baixada e preserva a trilha', async () => {
    const fixture = await createProduct({ quantity: 2, cost: 40 });
    const idempotencyKey = key('cancelar');
    const sale = await registerWalkinOrder(saleInput(fixture.productId, idempotencyKey), db.pool);

    await expect(cancelManualOrder({
      environment: 'test',
      order_id: sale.order_id,
      actor_label: 'Vitest Cancelador',
      reason: 'teste de devolucao',
    }, db.pool)).resolves.toEqual({ cancelled: true });

    const state = await db.pool.query<{ status: string; quantity: number }>(
      `SELECT o.status, s.quantity_on_hand AS quantity
         FROM commerce.orders o
         JOIN commerce.wholesale_stock s ON s.environment=o.environment AND s.measure=$2
        WHERE o.id=$1`,
      [sale.order_id, fixture.measure],
    );
    expect(state.rows[0]).toEqual({ status: 'cancelled', quantity: 2 });

    const audit = await db.pool.query<{ event_type: string }>(
      `SELECT event_type FROM audit.events
        WHERE entity_id=$1 AND event_type IN ('matriz_galpao_decrement','matriz_galpao_return')
        ORDER BY event_type`,
      [sale.order_id],
    );
    expect(audit.rows.map((row) => row.event_type)).toEqual([
      'matriz_galpao_decrement',
      'matriz_galpao_return',
    ]);
    const movements = await db.pool.query<{ qty_delta: number; source: string }>(
      `SELECT qty_delta, source FROM commerce.wholesale_stock_movements
        WHERE ref=$1 ORDER BY created_at`,
      [sale.order_id],
    );
    expect(movements.rows).toEqual([
      { qty_delta: -1, source: 'varejo' },
      { qty_delta: 1, source: 'cancelamento_varejo' },
    ]);
  });

  it('entrada calcula custo medio, ajuste redefine saldo e Financeiro usa a fonte oficial', async () => {
    const before = await getMatrizFinanceiroVisao('test', db.pool);
    const fixture = await createProduct({ quantity: 10, cost: 10 });

    const entry = await addWholesaleStockEntry({
      environment: 'test', measure: fixture.measure, quantity_in: 10, unit_cost: 30,
    }, db.pool);
    expect(entry).toMatchObject({ quantity_on_hand: 20, unit_cost: '20.00' });

    const adjusted = await setWholesaleStock({
      environment: 'test', measure: fixture.measure, quantity_on_hand: 7, unit_cost: 20,
    }, db.pool);
    expect(adjusted).toMatchObject({ quantity_on_hand: 7, unit_cost: '20.00' });

    const after = await getMatrizFinanceiroVisao('test', db.pool);
    expect(Number(after.indicadores.capital_parado) - Number(before.indicadores.capital_parado)).toBe(140);
    expect(after.indicadores.pneus_galpao - before.indicadores.pneus_galpao).toBe(7);
  });

  it('concilia produto sem estoque, estoque sem produto e isola prod de test', async () => {
    const aligned = await createProduct({ quantity: 4, cost: 12 });
    await db.pool.query(
      `INSERT INTO commerce.stock_levels (environment, product_id, quantity_available, location)
       VALUES ('test', $1, 4, 'main')`,
      [aligned.productId],
    );
    const catalogOnly = await createProduct({ withStock: false });
    const testOnlyMeasure = `${170 + sequence}/${60 + sequence}-${15 + sequence}`;
    const prodOnlyMeasure = `${190 + sequence}/${70 + sequence}-${16 + sequence}`;
    await db.pool.query(
      `INSERT INTO commerce.wholesale_stock (environment, measure, quantity_on_hand, unit_cost)
       VALUES ('test', $1, 3, 22), ('prod', $2, 9, 50)`,
      [testOnlyMeasure, prodOnlyMeasure],
    );

    const testReport = await getMatrizStockReconciliation('test', db.pool);
    const prodReport = await getMatrizStockReconciliation('prod', db.pool);
    expect(testReport.rows.find((row) => row.official_measures.includes(aligned.measure))?.status).toBe('aligned');
    expect(testReport.rows.find((row) => row.catalog_measures.includes(catalogOnly.measure))?.status).toBe('catalog_only');
    expect(testReport.rows.find((row) => row.official_measures.includes(testOnlyMeasure))?.status).toBe('official_only');
    expect(testReport.rows.some((row) => row.official_measures.includes(prodOnlyMeasure))).toBe(false);
    expect(prodReport.rows.some((row) => row.official_measures.includes(prodOnlyMeasure))).toBe(true);
    expect(prodReport.rows.some((row) => row.official_measures.includes(testOnlyMeasure))).toBe(false);
  });
});

async function installFailureTrigger(
  pool: Pool,
  options: {
    functionName: string;
    triggerName: string;
    table: string;
    timing: 'BEFORE INSERT' | 'BEFORE UPDATE';
    message: string;
  },
): Promise<void> {
  await pool.query(`
    CREATE FUNCTION public.${options.functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION '${options.message}';
    END $$;
    CREATE TRIGGER ${options.triggerName}
      ${options.timing} ON ${options.table}
      FOR EACH ROW EXECUTE FUNCTION public.${options.functionName}();
  `);
}

async function removeFailureTrigger(
  pool: Pool,
  table: string,
  triggerName: string,
  functionName: string,
): Promise<void> {
  await pool.query(`
    DROP TRIGGER IF EXISTS ${triggerName} ON ${table};
    DROP FUNCTION IF EXISTS public.${functionName}();
  `);
}
