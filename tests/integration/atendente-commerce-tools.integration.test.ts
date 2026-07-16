import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres';
import {
  buscarCompatibilidade,
  buscarPoliticaComercial,
  buscarProduto,
  calcularFrete,
  verificarEstoque,
} from '../../src/atendente/tools/commerce-tools.js';
import {
  buscarCompatibilidadeMatriz,
  buscarProdutoMatriz,
  verificarEstoqueMatriz,
} from '../../src/atendente-v2/matriz-product-search.js';

let db: IntegrationDb;
let client: PoolClient;
let fallbackPool: Pool | null = null;
let productId: string;
let productCode: string;
let geoId: string;
let vehicleId: string;
let motoModelo: string;
let bairro: string;
let policyKey: string;
let policyVersion: string;

beforeAll(async () => {
  try {
    db = await startPostgres();
    client = db.pool as unknown as PoolClient;
  } catch (error) {
    const databaseUrl = loadCodexDatabaseUrl();
    if (!databaseUrl) throw error;
    fallbackPool = new Pool({
      connectionString: databaseUrl,
      ssl: { rejectUnauthorized: false },
      max: 2,
    });
    client = fallbackPool as unknown as PoolClient;
  }
  const seed = await seedCommerceFixtures(client);
  productId = seed.productId;
  productCode = seed.productCode;
  geoId = seed.geoId;
  vehicleId = seed.vehicleId;
  motoModelo = seed.motoModelo;
  bairro = seed.bairro;
  policyKey = seed.policyKey;
  policyVersion = seed.policyVersion;
});

afterAll(async () => {
  if (fallbackPool) {
    await cleanupCommerceFixtures(fallbackPool as unknown as PoolClient, {
      productId,
      geoId,
      vehicleId,
      policyKey,
      policyVersion,
    });
    await fallbackPool.end();
    return;
  }
  if (db) await stopPostgres(db);
});

describe('Atendente commerce tools - integracao Postgres', () => {
  it('buscarProduto executa contra commerce.product_full real', async () => {
    const result = await buscarProduto(client, {
      environment: 'test',
      medida_pneu: '100/90 R17',
      marca: 'Pirelli',
      posicao_pneu: 'rear',
      apenas_com_estoque: true,
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      product_id: productId,
      product_code: productCode,
      price_amount: '175.00',
      total_stock_available: 4,
    });
  });

  it('verificarEstoque soma os locais reais de stock_levels', async () => {
    const result = await verificarEstoque(client, {
      environment: 'test',
      product_code: productCode,
    });

    expect(result).toMatchObject({
      product_id: productId,
      disponivel: true,
      quantidade_total: 4,
    });
    expect(result?.locations).toEqual([
      { location: 'main', quantity_available: 4, quantity_reserved: 0 },
    ]);
  });

  it('buscarCompatibilidade executa commerce.find_compatible_tires real', async () => {
    const result = await buscarCompatibilidade(client, {
      environment: 'test',
      moto_modelo: motoModelo,
      moto_ano: 2020,
      posicao_pneu: 'rear',
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.produtos).toEqual([
      expect.objectContaining({
        product_id: productId,
        tire_size: '100/90 R17',
        is_oem: true,
        total_stock: 4,
      }),
    ]);
  });

  it('tools oficiais da Matriz leem catalogo, fitment e wholesale_stock reais', async () => {
    const produtos = await buscarProdutoMatriz(client, {
      environment: 'test', medida_pneu: '100/90 R17', apenas_com_estoque: true, limit: 10,
    });
    expect(produtos[0]).toMatchObject({
      product_id: productId, total_stock_available: 3,
      stock_source: 'commerce.wholesale_stock', stock_block_reason: null,
    });

    const estoque = await verificarEstoqueMatriz(client, { environment: 'test', product_id: productId });
    expect(estoque).toMatchObject({
      disponivel: true, quantidade_total: 3, stock_source: 'commerce.wholesale_stock',
    });

    const compatibilidade = await buscarCompatibilidadeMatriz(client, {
      environment: 'test', moto_modelo: motoModelo, moto_ano: 2020, posicao_pneu: 'rear', limit: 10,
    });
    expect(compatibilidade[0]?.produtos[0]).toMatchObject({ product_id: productId, total_stock: 3 });
  });

  it('calcularFrete executa commerce.resolve_neighborhood e delivery_zones reais', async () => {
    const result = await calcularFrete(client, {
      environment: 'test',
      bairro,
      municipio: 'Rio de Janeiro',
    });

    expect(result).toMatchObject({
      encontrado: true,
      bairro_canonico: bairro,
      municipio: 'Rio de Janeiro',
      disponivel: true,
      valor: '0.00',
      prazo_dias: 1,
      delivery_mode: 'own_fleet',
    });
  });

  it('buscarPoliticaComercial le policies ativas reais', async () => {
    const result = await buscarPoliticaComercial(client, {
      environment: 'test',
      policy_keys: [policyKey],
    });

    expect(result).toEqual([
      {
        policy_key: policyKey,
        policy_value: { pct: 5 },
        description: 'Limite de desconto',
        policy_version: policyVersion,
      },
    ]);
  });
});

async function seedCommerceFixtures(
  client: PoolClient,
): Promise<{
  productId: string;
  productCode: string;
  geoId: string;
  vehicleId: string;
  motoModelo: string;
  bairro: string;
  policyKey: string;
  policyVersion: string;
}> {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const createdProductCode = `PIR-MT60-100-90-17-${suffix}`;
  const createdMotoModelo = `Bros Tools ${suffix}`;
  const createdBairro = `Meier Tools ${suffix}`;
  const createdPolicyKey = 'desconto_maximo';
  const createdPolicyVersion = `integration-${suffix}`;

  const product = await client.query<{ id: string }>(
    `INSERT INTO commerce.products
       (environment, product_code, product_name, product_type, brand, short_description)
     VALUES ('test', $1, 'Pirelli MT60', 'tire', 'Pirelli', 'Pneu traseiro')
     RETURNING id`,
    [createdProductCode],
  );
  const createdProductId = product.rows[0]!.id;

  const spec = await client.query<{ id: string }>(
    `INSERT INTO commerce.tire_specs
       (environment, product_id, tire_size, width_mm, aspect_ratio, rim_diameter,
        intended_use, position)
     VALUES ('test', $1, '100/90 R17', 100, 90, 17, 'mixed', 'rear')
     RETURNING id`,
    [createdProductId],
  );
  const tireSpecId = spec.rows[0]!.id;

  await client.query(
    `INSERT INTO commerce.stock_levels
       (environment, product_id, quantity_available, quantity_reserved, location)
     VALUES ('test', $1, 4, 0, 'main')`,
    [createdProductId],
  );

  await client.query(
    `INSERT INTO commerce.wholesale_stock (environment, measure, quantity_on_hand, unit_cost)
     VALUES ('test', '100/90 R17', 3, 40)`,
  );

  await client.query(
    `INSERT INTO commerce.product_prices
       (environment, product_id, price_amount, currency, price_type, valid_from)
     VALUES ('test', $1, 175.00, 'BRL', 'regular', '2026-01-01T00:00:00Z')`,
    [createdProductId],
  );

  const vehicle = await client.query<{ id: string }>(
    `INSERT INTO commerce.vehicle_models
       (environment, vehicle_type, make, model, year_start, year_end, displacement_cc)
     VALUES ('test', 'motorcycle', 'Honda', $1, 2015, 2024, 160)
     RETURNING id`,
    [createdMotoModelo],
  );
  const vehicleId = vehicle.rows[0]!.id;

  await client.query(
    `INSERT INTO commerce.vehicle_fitments
       (environment, vehicle_model_id, tire_spec_id, position, is_oem, source, confidence_level)
     VALUES ('test', $1, $2, 'rear', true, 'manual', 0.95)`,
    [vehicleId, tireSpecId],
  );

  const geo = await client.query<{ id: string }>(
     `INSERT INTO commerce.geo_resolutions
       (environment, neighborhood_name, neighborhood_canonical, city_name, state_code, aliases)
     VALUES ('test', $1, $1, 'Rio de Janeiro', 'RJ', ARRAY[]::text[])
     RETURNING id`,
    [createdBairro],
  );

  await client.query(
    `INSERT INTO commerce.delivery_zones
       (environment, geo_resolution_id, delivery_fee, delivery_days, is_available, delivery_mode)
     VALUES ('test', $1, 0.00, 1, true, 'own_fleet')`,
    [geo.rows[0]!.id],
  );

  await client.query(
     `INSERT INTO commerce.store_policies
       (environment, policy_key, policy_value, description, is_active, policy_version)
     VALUES ('test', $1, '{"pct": 5}'::jsonb,
             'Limite de desconto', true, $2)`,
    [createdPolicyKey, createdPolicyVersion],
  );

  return {
    productId: createdProductId,
    productCode: createdProductCode,
    geoId: geo.rows[0]!.id,
    vehicleId,
    motoModelo: createdMotoModelo,
    bairro: createdBairro,
    policyKey: createdPolicyKey,
    policyVersion: createdPolicyVersion,
  };
}

async function cleanupCommerceFixtures(
  client: PoolClient,
  ids: { productId: string; geoId: string; vehicleId: string; policyKey: string; policyVersion: string },
): Promise<void> {
  await client.query(`DELETE FROM commerce.wholesale_stock WHERE environment='test' AND measure='100/90 R17'`);
  await client.query(
    `DELETE FROM commerce.store_policies WHERE environment = 'test' AND policy_key = $1 AND policy_version = $2`,
    [ids.policyKey, ids.policyVersion],
  );
  await client.query(`DELETE FROM commerce.delivery_zones WHERE environment = 'test' AND geo_resolution_id = $1`, [
    ids.geoId,
  ]);
  await client.query(`DELETE FROM commerce.geo_resolutions WHERE id = $1`, [ids.geoId]);
  await client.query(`DELETE FROM commerce.vehicle_fitments WHERE environment = 'test' AND tire_spec_id IN (
    SELECT id FROM commerce.tire_specs WHERE product_id = $1
  )`, [ids.productId]);
  await client.query(`DELETE FROM commerce.vehicle_models WHERE id = $1`, [ids.vehicleId]);
  await client.query(`DELETE FROM commerce.product_prices WHERE product_id = $1`, [ids.productId]);
  await client.query(`DELETE FROM commerce.stock_levels WHERE product_id = $1`, [ids.productId]);
  await client.query(`DELETE FROM commerce.tire_specs WHERE product_id = $1`, [ids.productId]);
  await client.query(`DELETE FROM commerce.products WHERE id = $1`, [ids.productId]);
}

function loadCodexDatabaseUrl(): string | null {
  const envText = readFileSync('.env.codex', 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const match = line.match(/^DATABASE_URL=(.*)$/);
    if (match) return match[1]!.trim();
  }
  return null;
}
