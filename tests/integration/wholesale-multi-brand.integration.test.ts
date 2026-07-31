import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('estoque do galpão por medida, marca e condição', () => {
  let db: IntegrationDb;
  let registerPurchase:
    typeof import('../../src/admin/painel/queries-fornecedores-registro.js').registerWholesalePurchase;
  let decrement:
    typeof import('../../src/admin/painel/wholesale-stock.js').applyWholesaleStockDecrement;
  let priceReport:
    typeof import('../../src/admin/painel/queries-compras-relatorios.js').getWholesalePriceReport;
  let catalogOverview:
    typeof import('../../src/admin/painel/queries-catalogo.js').getCatalogOverview;
  let setCatalogPrice:
    typeof import('../../src/admin/painel/queries-catalogo.js').setCatalogPrice;
  let createCatalogProduct:
    typeof import('../../src/admin/painel/queries-catalogo-create.js').createCatalogProductFromStock;
  let registerSale:
    typeof import('../../src/admin/painel/queries-atacado-vendas.js').registerWholesaleSale;
  let cancelSale:
    typeof import('../../src/admin/painel/queries-atacado-cancelar.js').cancelWholesaleSale;
  let searchProducts:
    typeof import('../../src/atendente-v2/matriz-product-search.js').buscarProdutoMatriz;
  let transferCondition:
    typeof import('../../src/admin/painel/queries-stock-condition-transfer.js').transferWholesaleStockCondition;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      FAREJADOR_ENV: 'test',
      DATABASE_URL: 'postgres://test',
      CHATWOOT_HMAC_SECRET: 'test-secret',
      ADMIN_AUTH_TOKEN: 'emergency-token',
      WHOLESALE_FINANCE: 'false',
    });
    db = await startPostgres();
    ({ registerWholesalePurchase: registerPurchase }
      = await import('../../src/admin/painel/queries-fornecedores-registro.js'));
    ({ applyWholesaleStockDecrement: decrement }
      = await import('../../src/admin/painel/wholesale-stock.js'));
    ({ getWholesalePriceReport: priceReport }
      = await import('../../src/admin/painel/queries-compras-relatorios.js'));
    ({ getCatalogOverview: catalogOverview, setCatalogPrice }
      = await import('../../src/admin/painel/queries-catalogo.js'));
    ({ createCatalogProductFromStock: createCatalogProduct }
      = await import('../../src/admin/painel/queries-catalogo-create.js'));
    ({ registerWholesaleSale: registerSale }
      = await import('../../src/admin/painel/queries-atacado-vendas.js'));
    ({ cancelWholesaleSale: cancelSale }
      = await import('../../src/admin/painel/queries-atacado-cancelar.js'));
    ({ buscarProdutoMatriz: searchProducts }
      = await import('../../src/atendente-v2/matriz-product-search.js'));
    ({ transferWholesaleStockCondition: transferCondition }
      = await import('../../src/admin/painel/queries-stock-condition-transfer.js'));

    const product = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.products
         (environment,product_code,product_name,product_type,brand,tire_condition)
       VALUES ('test',$1,'Pneu multimarcas','tire','Pirelli','meia_vida')
       RETURNING id`,
      [`MULTI-${Date.now()}`],
    );
    await db.pool.query(
      `INSERT INTO commerce.tire_specs
         (environment,product_id,tire_size,width_mm,aspect_ratio,rim_diameter)
       VALUES ('test',$1,'90/90-18',90,90,18)`,
      [product.rows[0]!.id],
    );
  }, 180_000);

  afterAll(async () => {
    if (db) await stopPostgres(db);
  });

  it('registra duas marcas na mesma compra e movimenta apenas a variante vendida', async () => {
    await registerPurchase({
      environment: 'test',
      new_supplier: { name: 'Fornecedor multimarcas' },
      created_by: 'teste-multimarcas',
      receipt_status: 'received',
      idempotency_key: randomUUID(),
      items: [
        { measure: '90/90-18', brand: 'Pirelli', tire_condition: 'meia_vida',
          quantity: 2, unit_cost: 100 },
        { measure: '90/90-18', brand: 'Metzeler', tire_condition: 'meia_vida',
          quantity: 3, unit_cost: 120 },
      ],
    }, db.pool);

    const before = await db.pool.query<{
      brand: string; quantity_on_hand: number; unit_cost: string;
    }>(
      `SELECT brand,quantity_on_hand,unit_cost::text
         FROM commerce.wholesale_stock
        WHERE environment='test' AND measure='90/90-18'
        ORDER BY brand`,
    );
    expect(before.rows).toEqual([
      { brand: 'Metzeler', quantity_on_hand: 3, unit_cost: '120.00' },
      { brand: 'Pirelli', quantity_on_hand: 2, unit_cost: '100.00' },
    ]);

    const prices = await priceReport({ period: 'all' }, 'test', db.pool) as Array<{
      measure: string; brand: string; avg_cost: string;
    }>;
    expect(prices.map((row) => ({
      measure: row.measure, brand: row.brand, avg_cost: row.avg_cost,
    }))).toEqual([
      { measure: '90/90-18', brand: 'Metzeler', avg_cost: '120.00' },
      { measure: '90/90-18', brand: 'Pirelli', avg_cost: '100.00' },
    ]);

    const catalog = await catalogOverview('test', db.pool);
    expect(catalog.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tire_size: '90/90-18', brand: 'Pirelli', catalogued: true,
        official_quantity_on_hand: 2,
      }),
      expect.objectContaining({
        tire_size: '90/90-18', brand: 'Metzeler', catalogued: false,
        official_quantity_on_hand: 3, block_reason: 'catalog_product_missing',
      }),
    ]));

    const created = await createCatalogProduct({
      measure: '90/90-18',
      brand: 'Metzeler',
      productCode: `MULTI-MET-${Date.now()}`,
      productName: 'Pneu Metzeler 90/90-18',
      tireCondition: 'meia_vida',
      actorLabel: 'teste-multimarcas',
      environment: 'test',
    }, db.pool);
    const withoutPrice = await catalogOverview('test', db.pool);
    expect(withoutPrice.rows).toContainEqual(expect.objectContaining({
      product_id: created.product_id,
      tire_size: '90/90-18',
      brand: 'Metzeler',
      catalogued: true,
      official_quantity_on_hand: 3,
      price_amount: null,
      sellable: false,
      block_reason: 'catalog_price_missing',
    }));

    await setCatalogPrice({
      productId: created.product_id,
      priceAmount: 180,
      reason: 'Preco inicial do produto',
      actorLabel: 'teste-multimarcas',
      environment: 'test',
    }, db.pool);
    const sellable = await catalogOverview('test', db.pool);
    expect(sellable.rows).toContainEqual(expect.objectContaining({
      product_id: created.product_id,
      brand: 'Metzeler',
      price_amount: 180,
      sellable: true,
      block_reason: null,
    }));

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await decrement(client as PoolClient, 'test', [{
        measure: '90/90-18', brand: 'Metzeler', tire_condition: 'meia_vida', quantity: 2,
      }], true, 'venda-multimarcas');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const after = await db.pool.query<{ brand: string; quantity_on_hand: number }>(
      `SELECT brand,quantity_on_hand
         FROM commerce.wholesale_stock
        WHERE environment='test' AND measure='90/90-18'
        ORDER BY brand`,
    );
    expect(after.rows).toEqual([
      { brand: 'Metzeler', quantity_on_hand: 1 },
      { brand: 'Pirelli', quantity_on_hand: 2 },
    ]);

    const movement = await db.pool.query<{ brand: string; qty_delta: number }>(
      `SELECT brand,qty_delta
         FROM commerce.wholesale_stock_movements
        WHERE environment='test' AND ref='venda-multimarcas'
        ORDER BY created_at DESC LIMIT 1`,
    );
    expect(movement.rows[0]).toEqual({ brand: 'Metzeler', qty_delta: -2 });
  });

  it('isola três condições, custo ponderado, bot, venda, cancelamento e compatibilidade', async () => {
    const baseSpec = await db.pool.query<{ id: string }>(
      `SELECT ts.id
         FROM commerce.tire_specs ts
         JOIN commerce.products p ON p.id=ts.product_id AND p.environment=ts.environment
        WHERE p.environment='test' AND p.brand='Pirelli'
          AND p.tire_condition='meia_vida' AND ts.tire_size='90/90-18'`,
    );
    const vehicle = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.vehicle_models
         (environment,vehicle_type,make,model,year_start,year_end,displacement_cc)
       VALUES ('test','motorcycle','Honda',$1,2015,2026,160)
       RETURNING id`,
      [`CG Condicao ${Date.now()}`],
    );
    await db.pool.query(
      `INSERT INTO commerce.vehicle_fitments
         (environment,vehicle_model_id,tire_spec_id,position,is_oem,source,confidence_level)
       VALUES ('test',$1,$2,'rear',true,'manual',0.95)`,
      [vehicle.rows[0]!.id, baseSpec.rows[0]!.id],
    );

    for (const purchase of [
      { supplier: 'Xico', condition: 'novo' as const, quantity: 10, cost: 100 },
      { supplier: 'Francisco', condition: 'novo' as const, quantity: 5, cost: 120 },
      { supplier: 'Recapadora', condition: 'remold' as const, quantity: 4, cost: 70 },
    ]) {
      await registerPurchase({
        environment: 'test',
        new_supplier: { name: `${purchase.supplier} ${Date.now()} ${randomUUID()}` },
        created_by: 'teste-condicoes',
        receipt_status: 'received',
        idempotency_key: randomUUID(),
        items: [{
          measure: '90/90-18', brand: 'Pirelli',
          tire_condition: purchase.condition,
          quantity: purchase.quantity, unit_cost: purchase.cost,
        }],
      }, db.pool);
    }

    const variants = await db.pool.query<{
      tire_condition: string; quantity_on_hand: number; unit_cost: string;
    }>(
      `SELECT tire_condition,quantity_on_hand,unit_cost::text
         FROM commerce.wholesale_stock
        WHERE environment='test' AND measure='90/90-18' AND brand='Pirelli'
        ORDER BY tire_condition`,
    );
    expect(variants.rows).toEqual([
      { tire_condition: 'meia_vida', quantity_on_hand: 2, unit_cost: '100.00' },
      { tire_condition: 'novo', quantity_on_hand: 15, unit_cost: '106.67' },
      { tire_condition: 'remold', quantity_on_hand: 4, unit_cost: '70.00' },
    ]);

    const created = [];
    for (const entry of [
      { condition: 'novo' as const, price: 220 },
      { condition: 'remold' as const, price: 145 },
    ]) {
      const product = await createCatalogProduct({
        measure: '90/90-18',
        brand: 'Pirelli',
        tireCondition: entry.condition,
        productCode: `PIRELLI-909018-${entry.condition}-${Date.now()}`,
        productName: `Pneu Pirelli 90/90-18 ${entry.condition}`,
        actorLabel: 'teste-condicoes',
        environment: 'test',
      }, db.pool);
      created.push({ ...product, condition: entry.condition, price: entry.price });
      await setCatalogPrice({
        productId: product.product_id,
        priceAmount: entry.price,
        reason: `Preço inicial ${entry.condition}`,
        actorLabel: 'teste-condicoes',
        environment: 'test',
      }, db.pool);
    }

    const inherited = await db.pool.query<{ tire_condition: string }>(
      `SELECT p.tire_condition
         FROM commerce.vehicle_fitments vf
         JOIN commerce.tire_specs ts ON ts.id=vf.tire_spec_id
         JOIN commerce.products p ON p.id=ts.product_id
        WHERE vf.environment='test' AND vf.vehicle_model_id=$1
        ORDER BY p.tire_condition`,
      [vehicle.rows[0]!.id],
    );
    expect(inherited.rows.map((row) => row.tire_condition)).toEqual([
      'meia_vida', 'novo', 'remold',
    ]);

    const client = await db.pool.connect();
    try {
      const generic = await searchProducts(client, {
        environment: 'test', medida_pneu: '90/90-18', marca: 'Pirelli',
        apenas_com_estoque: true, limit: 10,
      });
      expect(generic.map((row) => row.tire_condition).sort()).toEqual([
        'meia_vida', 'novo', 'remold',
      ]);
      const onlyNew = await searchProducts(client, {
        environment: 'test', medida_pneu: '90/90-18', marca: 'Pirelli',
        condicao_pneu: 'novo', apenas_com_estoque: true, limit: 10,
      });
      expect(onlyNew).toEqual([
        expect.objectContaining({
          tire_condition: 'novo',
          price_amount: '220.00',
          total_stock_available: 15,
        }),
      ]);
    } finally {
      client.release();
    }

    const sale = await registerSale({
      environment: 'test',
      new_customer: { name: `Cliente condições ${Date.now()}` },
      created_by: 'teste-condicoes',
      idempotency_key: randomUUID(),
      items: [
        { measure: '90/90-18', brand: 'Pirelli', tire_condition: 'novo',
          quantity: 2, unit_price: 220 },
        { measure: '90/90-18', brand: 'Pirelli', tire_condition: 'remold',
          quantity: 1, unit_price: 145 },
      ],
    }, db.pool);
    const afterSale = await db.pool.query<{
      tire_condition: string; quantity_on_hand: number;
    }>(
      `SELECT tire_condition,quantity_on_hand
         FROM commerce.wholesale_stock
        WHERE environment='test' AND measure='90/90-18' AND brand='Pirelli'
        ORDER BY tire_condition`,
    );
    expect(afterSale.rows).toEqual([
      { tire_condition: 'meia_vida', quantity_on_hand: 2 },
      { tire_condition: 'novo', quantity_on_hand: 13 },
      { tire_condition: 'remold', quantity_on_hand: 3 },
    ]);
    const snapshots = await db.pool.query<{ tire_condition: string }>(
      `SELECT tire_condition FROM commerce.wholesale_order_items
        WHERE order_id=$1 ORDER BY tire_condition`,
      [sale.order_id],
    );
    expect(snapshots.rows.map((row) => row.tire_condition)).toEqual(['novo', 'remold']);

    const cancelled = await cancelSale({
      order_id: sale.order_id,
      cancelled_by: 'teste-condicoes',
      reason: 'teste de devolução por condição',
      environment: 'test',
      idempotency_key: randomUUID(),
    }, db.pool);
    expect(cancelled.stock_returned).toEqual([
      { measure: '90/90-18', brand: 'Pirelli', tire_condition: 'novo', quantity: 2 },
      { measure: '90/90-18', brand: 'Pirelli', tire_condition: 'remold', quantity: 1 },
    ]);
    const afterCancel = await db.pool.query<{
      tire_condition: string; quantity_on_hand: number;
    }>(
      `SELECT tire_condition,quantity_on_hand
         FROM commerce.wholesale_stock
        WHERE environment='test' AND measure='90/90-18' AND brand='Pirelli'
        ORDER BY tire_condition`,
    );
    expect(afterCancel.rows).toEqual([
      { tire_condition: 'meia_vida', quantity_on_hand: 2 },
      { tire_condition: 'novo', quantity_on_hand: 15 },
      { tire_condition: 'remold', quantity_on_hand: 4 },
    ]);

    const correctionKey = randomUUID();
    const corrected = await transferCondition({
      measure: '90/90-18',
      brand: 'Pirelli',
      from_condition: 'remold',
      to_condition: 'novo',
      quantity: 2,
      reason: 'condição informada errada na compra',
      idempotency_key: correctionKey,
      actor_label: 'teste-condicoes',
      environment: 'test',
    }, db.pool);
    expect(corrected).toEqual({
      measure: '90/90-18',
      brand: 'Pirelli',
      from_condition: 'remold',
      to_condition: 'novo',
      transferred_quantity: 2,
      source_quantity: 2,
      target_quantity: 17,
      target_unit_cost: 102.36,
    });
    expect(await transferCondition({
      measure: '90/90-18',
      brand: 'Pirelli',
      from_condition: 'remold',
      to_condition: 'novo',
      quantity: 2,
      reason: 'condição informada errada na compra',
      idempotency_key: correctionKey,
      actor_label: 'teste-condicoes',
      environment: 'test',
    }, db.pool)).toEqual(corrected);
    const correctionAudit = await db.pool.query<{ event_type: string }>(
      `SELECT event_type FROM audit.events
        WHERE environment='test' AND idempotency_key=$1`,
      [correctionKey],
    );
    expect(correctionAudit.rows).toEqual([{ event_type: 'condition_transferred' }]);
  });
});
