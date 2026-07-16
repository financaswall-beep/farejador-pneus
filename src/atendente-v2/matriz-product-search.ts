import type { PoolClient } from 'pg';
import {
  buscarCompatibilidadeInputSchema,
  buscarProdutoInputSchema,
  verificarEstoqueInputSchema,
  type BuscarCompatibilidadeInput,
  type BuscarProdutoInput,
  type CompatibilidadeResultado,
  type EstoqueProduto,
  type ProdutoOferta,
  type VerificarEstoqueInput,
} from '../atendente/tools/commerce-tools.js';
import { buildMatrizStockIndex, matrizStockForMeasure } from '../shared/matriz-stock-source.js';
import { tireSizeKey } from '../shared/tire-size.js';

interface CatalogRow {
  product_id: string;
  product_code: string;
  product_name: string;
  product_type: string;
  brand: string | null;
  short_description: string | null;
  tire_size: string | null;
  tire_position: 'front' | 'rear' | 'both' | null;
  intended_use: string | null;
  price_amount: string | null;
  currency: string | null;
  price_type: string | null;
}

interface OfficialStockRow {
  measure: string;
  quantity_on_hand: number | string;
  unit_cost: number | string | null;
}

interface StockProvenance {
  stock_source: 'commerce.wholesale_stock';
  stock_block_reason: string | null;
}

export async function buscarProdutoMatriz(
  client: PoolClient,
  input: BuscarProdutoInput,
  options: { deferAvailabilityFilter?: boolean } = {},
): Promise<Array<ProdutoOferta & StockProvenance>> {
  const parsed = buscarProdutoInputSchema.parse(input);
  const values: unknown[] = [parsed.environment];
  const filters = ['p.environment = $1', 'p.deleted_at IS NULL'];
  if (parsed.marca) {
    values.push(parsed.marca);
    filters.push(`p.brand ILIKE '%' || $${values.length} || '%'`);
  }
  if (parsed.product_code) {
    values.push(parsed.product_code);
    filters.push(`p.product_code = $${values.length}`);
  }
  if (parsed.posicao_pneu && parsed.posicao_pneu !== 'both') {
    values.push(parsed.posicao_pneu);
    filters.push(`(ts.position = $${values.length} OR ts.position = 'both')`);
  }
  const catalog = await client.query<CatalogRow>(catalogSql(filters), values);
  const stock = await loadOfficialStock(client, parsed.environment);
  const index = buildMatrizStockIndex(stock);
  const requestedKey = tireSizeKey(parsed.medida_pneu);

  return catalog.rows
    .filter((row) => !requestedKey || tireSizeKey(row.tire_size) === requestedKey)
    .map((row) => {
      const state = matrizStockForMeasure(index, row.tire_size);
      return {
        ...row,
        total_stock_available: state.sellable ? state.quantity_on_hand : 0,
        stock_source: 'commerce.wholesale_stock' as const,
        stock_block_reason: state.block_reason,
      };
    })
    .filter((row) => options.deferAvailabilityFilter || !parsed.apenas_com_estoque || row.total_stock_available > 0)
    .sort((a, b) => b.total_stock_available - a.total_stock_available
      || comparePrice(a.price_amount, b.price_amount)
      || a.product_name.localeCompare(b.product_name, 'pt-BR'))
    .slice(0, options.deferAvailabilityFilter ? undefined : parsed.limit);
}

export async function verificarEstoqueMatriz(
  client: PoolClient,
  input: VerificarEstoqueInput,
): Promise<(EstoqueProduto & StockProvenance & { quantidade_fisica_oficial: number }) | null> {
  const parsed = verificarEstoqueInputSchema.parse(input);
  const values: unknown[] = [parsed.environment];
  const filters = ['p.environment = $1', 'p.deleted_at IS NULL'];
  if (parsed.product_id) {
    values.push(parsed.product_id);
    filters.push(`p.id = $${values.length}`);
  }
  if (parsed.product_code) {
    values.push(parsed.product_code);
    filters.push(`p.product_code = $${values.length}`);
  }
  const product = await client.query<CatalogRow>(catalogSql(filters), values);
  const row = product.rows[0];
  if (!row) return null;
  const stock = await loadOfficialStock(client, parsed.environment);
  const state = matrizStockForMeasure(buildMatrizStockIndex(stock), row.tire_size);
  const available = state.sellable ? state.quantity_on_hand : 0;
  return {
    product_id: row.product_id,
    product_code: row.product_code,
    product_name: row.product_name,
    disponivel: state.sellable,
    quantidade_total: available,
    quantidade_fisica_oficial: state.quantity_on_hand,
    locations: [{ location: 'matriz_galpao', quantity_available: available, quantity_reserved: 0 }],
    stock_source: 'commerce.wholesale_stock',
    stock_block_reason: state.block_reason,
  };
}

interface VehicleRow {
  vehicle_model_id: string;
  make: string;
  model: string;
  variant: string | null;
  year_start: number | null;
  year_end: number | null;
  displacement_cc: number | null;
}

interface FitmentRow {
  vehicle_model_id: string;
  product_id: string;
  product_name: string;
  brand: string | null;
  tire_size: string;
  position: 'front' | 'rear' | 'both';
  is_oem: boolean;
  source: string;
  confidence_level: string | null;
  current_price: string | null;
}

export async function buscarCompatibilidadeMatriz(
  client: PoolClient,
  input: BuscarCompatibilidadeInput,
  options: { deferLimit?: boolean } = {},
): Promise<CompatibilidadeResultado[]> {
  const parsed = buscarCompatibilidadeInputSchema.parse(input);
  const vehicles = await client.query<VehicleRow>(
    `SELECT * FROM commerce.resolve_vehicle_model($1, $2, $3) LIMIT 5`,
    [parsed.environment, parsed.moto_modelo, parsed.moto_ano ?? null],
  );
  if (vehicles.rows.length === 0) return [];
  const position = parsed.posicao_pneu && parsed.posicao_pneu !== 'both' ? parsed.posicao_pneu : null;
  const fitments = await client.query<FitmentRow>(
    `SELECT vf.vehicle_model_id, p.id AS product_id, p.product_name, p.brand,
            ts.tire_size, vf.position, vf.is_oem, vf.source,
            vf.confidence_level, cp.price_amount AS current_price
       FROM commerce.vehicle_fitments vf
       JOIN commerce.tire_specs ts
         ON ts.id = vf.tire_spec_id AND ts.environment = vf.environment
       JOIN commerce.products p
         ON p.id = ts.product_id AND p.environment = ts.environment AND p.deleted_at IS NULL
       LEFT JOIN commerce.current_prices cp
         ON cp.product_id = p.id AND cp.environment = p.environment
      WHERE vf.environment = $1 AND vf.vehicle_model_id = ANY($2::uuid[])
        AND ($3::text IS NULL OR vf.position = $3 OR vf.position = 'both')`,
    [parsed.environment, vehicles.rows.map((row) => row.vehicle_model_id), position],
  );
  const stock = await loadOfficialStock(client, parsed.environment);
  const index = buildMatrizStockIndex(stock);
  return vehicles.rows.map((vehicle) => ({
    ...vehicle,
    produtos: fitments.rows
      .filter((row) => row.vehicle_model_id === vehicle.vehicle_model_id)
      .map((row) => {
        const state = matrizStockForMeasure(index, row.tire_size);
        return {
          product_id: row.product_id,
          product_name: row.product_name,
          brand: row.brand,
          tire_size: row.tire_size,
          position: row.position,
          is_oem: row.is_oem,
          source: row.source,
          confidence_level: row.confidence_level,
          current_price: row.current_price,
          total_stock: state.sellable ? state.quantity_on_hand : 0,
          stock_source: 'commerce.wholesale_stock',
          stock_block_reason: state.block_reason,
        };
      })
      .sort((a, b) => b.total_stock - a.total_stock || comparePrice(a.current_price, b.current_price))
      .slice(0, options.deferLimit ? undefined : parsed.limit),
  })) as CompatibilidadeResultado[];
}

function catalogSql(filters: string[]): string {
  return `SELECT p.id AS product_id, p.product_code, p.product_name, p.product_type, p.brand,
                 p.short_description, ts.tire_size, ts.position AS tire_position, ts.intended_use,
                 cp.price_amount, cp.currency, cp.price_type
            FROM commerce.products p
            LEFT JOIN commerce.tire_specs ts
              ON ts.product_id = p.id AND ts.environment = p.environment
            LEFT JOIN commerce.current_prices cp
              ON cp.product_id = p.id AND cp.environment = p.environment
           WHERE ${filters.join(' AND ')}`;
}

async function loadOfficialStock(client: PoolClient, environment: 'prod' | 'test'): Promise<OfficialStockRow[]> {
  const result = await client.query<OfficialStockRow>(
    `SELECT measure, quantity_on_hand, unit_cost
       FROM commerce.wholesale_stock
      WHERE environment = $1`,
    [environment],
  );
  return result.rows;
}

function comparePrice(a: string | null, b: string | null): number {
  const left = a === null ? Number.POSITIVE_INFINITY : Number(a);
  const right = b === null ? Number.POSITIVE_INFINITY : Number(b);
  return left - right;
}
