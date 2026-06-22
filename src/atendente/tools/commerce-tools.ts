import type { PoolClient } from 'pg';
import { z } from 'zod';
import { logger } from '../../shared/logger.js';
import type { Environment } from '../../shared/types/chatwoot.js';
import { isKnownPolicyKey, parsePolicyValue } from '../policies/policy-schemas.js';

const tirePositionSchema = z.enum(['front', 'rear', 'both']);

export const buscarProdutoInputSchema = z.object({
  environment: z.enum(['prod', 'test']),
  medida_pneu: z.string().trim().min(1).optional(),
  marca: z.string().trim().min(1).optional(),
  posicao_pneu: tirePositionSchema.optional(),
  product_code: z.string().trim().min(1).optional(),
  apenas_com_estoque: z.boolean().default(false),
  limit: z.number().int().min(1).max(20).default(10),
}).refine((data) => Boolean(data.medida_pneu || data.marca || data.product_code), {
  message: 'buscarProduto exige medida_pneu, marca ou product_code',
});

export const verificarEstoqueInputSchema = z.object({
  environment: z.enum(['prod', 'test']),
  product_id: z.string().uuid().optional(),
  product_code: z.string().trim().min(1).optional(),
}).refine((data) => Boolean(data.product_id || data.product_code), {
  message: 'verificarEstoque exige product_id ou product_code',
});

export const buscarCompatibilidadeInputSchema = z.object({
  environment: z.enum(['prod', 'test']),
  moto_modelo: z.string().trim().min(1),
  moto_ano: z.number().int().min(1900).max(2100).optional(),
  posicao_pneu: tirePositionSchema.optional(),
  limit: z.number().int().min(1).max(20).default(10),
});

export const calcularFreteInputSchema = z.object({
  environment: z.enum(['prod', 'test']),
  bairro: z.string().trim().min(1),
  municipio: z.string().trim().min(1).optional(),
});

export const buscarPoliticaComercialInputSchema = z.object({
  environment: z.enum(['prod', 'test']),
  policy_keys: z.array(z.string().trim().min(1)).max(20).optional(),
});

export type BuscarProdutoInput = z.infer<typeof buscarProdutoInputSchema>;
export type VerificarEstoqueInput = z.infer<typeof verificarEstoqueInputSchema>;
export type BuscarCompatibilidadeInput = z.infer<typeof buscarCompatibilidadeInputSchema>;
export type CalcularFreteInput = z.infer<typeof calcularFreteInputSchema>;
export type BuscarPoliticaComercialInput = z.infer<typeof buscarPoliticaComercialInputSchema>;

export interface ProdutoOferta {
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
  total_stock_available: number;
}

export interface EstoqueProduto {
  product_id: string;
  product_code: string;
  product_name: string;
  disponivel: boolean;
  quantidade_total: number;
  locations: Array<{
    location: string;
    quantity_available: number;
    quantity_reserved: number;
  }>;
}

export interface CompatibilidadeResultado {
  vehicle_model_id: string;
  make: string;
  model: string;
  variant: string | null;
  year_start: number | null;
  year_end: number | null;
  displacement_cc: number | null;
  produtos: Array<{
    product_id: string;
    product_name: string;
    brand: string | null;
    tire_size: string;
    position: 'front' | 'rear' | 'both';
    is_oem: boolean;
    source: string;
    confidence_level: string | null;
    current_price: string | null;
    total_stock: number;
  }>;
}

export interface FreteResultado {
  encontrado: boolean;
  bairro_canonico: string | null;
  municipio: string | null;
  match_type: string | null;
  similarity: string | null;
  disponivel: boolean;
  valor: string | null;
  prazo_dias: number | null;
  delivery_mode: string | null;
  geo_resolution_id: string | null;
  motivo?: string;
}

export interface PoliticaComercial {
  policy_key: string;
  policy_value: unknown;
  description: string | null;
  policy_version: string;
}

interface ProductFullRow {
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
  total_stock_available: string | number | null;
}

interface StockRow {
  product_id: string;
  product_code: string;
  product_name: string;
  location: string;
  quantity_available: number;
  quantity_reserved: number;
}

interface VehicleRow {
  id?: string;
  vehicle_model_id?: string;
  make: string;
  model: string;
  variant: string | null;
  year_start: number | null;
  year_end: number | null;
  displacement_cc: number | null;
  match_type?: string;
  match_similarity?: string;
}

interface CompatibleTireRow {
  product_id: string;
  product_name: string;
  brand: string | null;
  tire_size: string;
  position?: 'front' | 'rear' | 'both';
  fitment_position?: 'front' | 'rear' | 'both';
  is_oem: boolean;
  source?: string;
  fitment_source?: string;
  confidence_level: string | null;
  current_price: string | null;
  total_stock: number;
}

interface ResolvedGeoRow {
  geo_resolution_id: string;
  neighborhood_canonical: string;
  city_name: string;
  match_type: string;
  similarity?: string;
  match_similarity?: string;
}

interface DeliveryZoneRow {
  delivery_fee: string;
  delivery_days: number;
  is_available: boolean;
  delivery_mode: string;
}

interface PolicyRow {
  policy_key: string;
  policy_value: unknown;
  description: string | null;
  policy_version: string;
}

export async function buscarProduto(
  client: PoolClient,
  input: BuscarProdutoInput,
): Promise<ProdutoOferta[]> {
  const parsed = buscarProdutoInputSchema.parse(input);
  const values: unknown[] = [parsed.environment];
  const filters = ['environment = $1'];

  if (parsed.medida_pneu) {
    values.push(normalizeTireSize(parsed.medida_pneu));
    filters.push(`replace(replace(lower(COALESCE(tire_size, '')), ' ', ''), 'r', '-') = $${values.length}`);
  }
  if (parsed.marca) {
    values.push(parsed.marca);
    filters.push(`brand ILIKE '%' || $${values.length} || '%'`);
  }
  // 'both' = alias semântico de "qualquer posição" (MESMO fix do buscar_compatibilidade,
  // 2026-05-23): sem este guard, posicao_pneu='both' virava `tire_position='both'` e
  // excluía os pneus de posição ÚNICA (front/rear) — ex.: o 80/90-21 (dianteiro) sumia
  // da busca por MEDIDA mesmo a Matriz tendo estoque. Só filtra quando é front/rear.
  if (parsed.posicao_pneu && parsed.posicao_pneu !== 'both') {
    values.push(parsed.posicao_pneu);
    filters.push(`(tire_position = $${values.length} OR tire_position = 'both')`);
  }
  if (parsed.product_code) {
    values.push(parsed.product_code);
    filters.push(`product_code = $${values.length}`);
  }
  if (parsed.apenas_com_estoque) {
    filters.push('total_stock_available > 0');
  }

  values.push(parsed.limit);
  const result = await client.query<ProductFullRow>(
    `SELECT product_id, product_code, product_name, product_type, brand,
            short_description, tire_size, tire_position, intended_use,
            price_amount, currency, price_type, total_stock_available
     FROM commerce.product_full
     WHERE ${filters.join(' AND ')}
     ORDER BY total_stock_available DESC, price_amount NULLS LAST, product_name ASC
     LIMIT $${values.length}`,
    values,
  );

  return result.rows.map(mapProdutoOferta);
}

export async function verificarEstoque(
  client: PoolClient,
  input: VerificarEstoqueInput,
): Promise<EstoqueProduto | null> {
  const parsed = verificarEstoqueInputSchema.parse(input);
  if (!parsed.product_id && !parsed.product_code) {
    throw new Error('verificarEstoque exige product_id ou product_code');
  }

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

  const result = await client.query<StockRow>(
    `SELECT p.id AS product_id, p.product_code, p.product_name,
            sl.location, sl.quantity_available, sl.quantity_reserved
     FROM commerce.products p
     LEFT JOIN commerce.stock_levels sl
       ON sl.product_id = p.id AND sl.environment = p.environment
     WHERE ${filters.join(' AND ')}
     ORDER BY sl.location NULLS LAST`,
    values,
  );

  if (result.rows.length === 0) return null;
  const first = result.rows[0]!;
  const locations = result.rows
    .filter((row) => row.location !== null)
    .map((row) => ({
      location: row.location,
      quantity_available: Number(row.quantity_available ?? 0),
      quantity_reserved: Number(row.quantity_reserved ?? 0),
    }));
  const quantidadeTotal = locations.reduce((sum, row) => sum + row.quantity_available, 0);

  return {
    product_id: first.product_id,
    product_code: first.product_code,
    product_name: first.product_name,
    disponivel: quantidadeTotal > 0,
    quantidade_total: quantidadeTotal,
    locations,
  };
}

export async function buscarCompatibilidade(
  client: PoolClient,
  input: BuscarCompatibilidadeInput,
): Promise<CompatibilidadeResultado[]> {
  const parsed = buscarCompatibilidadeInputSchema.parse(input);
  const vehicleResult = await client.query<VehicleRow>(
    `SELECT *
     FROM commerce.resolve_vehicle_model($1, $2, $3)
     LIMIT 5`,
    [parsed.environment, parsed.moto_modelo, parsed.moto_ano ?? null],
  );

  const out: CompatibilidadeResultado[] = [];
  for (const vehicle of vehicleResult.rows) {
    const vehicleId = vehicle.vehicle_model_id ?? vehicle.id;
    if (!vehicleId) throw new Error('resolve_vehicle_model returned no vehicle id');
    // Fix (2026-05-23): a funcao SQL find_compatible_tires aceita apenas
    // 'front', 'rear' ou NULL. O schema da tool aceita 'both' (alias semantico
    // de "todos os pneus"), entao traduzimos 'both' -> NULL antes da query.
    // Sem isso, posicao_pneu='both' virava WHERE position='both' e zero matches.
    const positionFilter = parsed.posicao_pneu && parsed.posicao_pneu !== 'both'
      ? parsed.posicao_pneu
      : null;
    const tires = await client.query<CompatibleTireRow>(
      `SELECT *
       FROM commerce.find_compatible_tires($1, $2, $3)
       LIMIT $4`,
      [parsed.environment, vehicleId, positionFilter, parsed.limit],
    );
    out.push({
      vehicle_model_id: vehicleId,
      make: vehicle.make,
      model: vehicle.model,
      variant: vehicle.variant,
      year_start: vehicle.year_start,
      year_end: vehicle.year_end,
      displacement_cc: vehicle.displacement_cc,
      produtos: tires.rows.map(mapCompatibleTire),
    });
  }
  return out;
}

export async function calcularFrete(
  client: PoolClient,
  input: CalcularFreteInput,
): Promise<FreteResultado> {
  const parsed = calcularFreteInputSchema.parse(input);
  const geoResult = await client.query<ResolvedGeoRow>(
    `SELECT *
     FROM commerce.resolve_neighborhood($1, $2, $3)
     LIMIT 1`,
    [parsed.environment, parsed.bairro, parsed.municipio ?? null],
  );

  const geo = geoResult.rows[0];
  if (!geo) {
    return {
      encontrado: false,
      bairro_canonico: null,
      municipio: parsed.municipio ?? null,
      match_type: null,
      similarity: null,
      disponivel: false,
      valor: null,
      prazo_dias: null,
      delivery_mode: null,
      geo_resolution_id: null,
      motivo: 'bairro_nao_encontrado',
    };
  }

  const zoneResult = await client.query<DeliveryZoneRow>(
    `SELECT delivery_fee, delivery_days, is_available, delivery_mode
     FROM commerce.delivery_zones
     WHERE environment = $1
       AND geo_resolution_id = $2
     ORDER BY is_available DESC, delivery_fee ASC
     LIMIT 1`,
    [parsed.environment, geo.geo_resolution_id],
  );
  const zone = zoneResult.rows[0];
  if (!zone) {
    return {
      encontrado: true,
      bairro_canonico: geo.neighborhood_canonical,
      municipio: geo.city_name,
      match_type: geo.match_type,
      similarity: geo.similarity ?? geo.match_similarity ?? null,
      disponivel: false,
      valor: null,
      prazo_dias: null,
      delivery_mode: null,
      geo_resolution_id: geo.geo_resolution_id,
      motivo: 'zona_sem_configuracao',
    };
  }

  return {
    encontrado: true,
    bairro_canonico: geo.neighborhood_canonical,
    municipio: geo.city_name,
    match_type: geo.match_type,
    similarity: geo.similarity ?? geo.match_similarity ?? null,
    disponivel: zone.is_available,
    valor: zone.delivery_fee,
    prazo_dias: zone.delivery_days,
    delivery_mode: zone.delivery_mode,
    geo_resolution_id: geo.geo_resolution_id,
    motivo: zone.is_available ? undefined : 'entrega_indisponivel',
  };
}

export async function buscarPoliticaComercial(
  client: PoolClient,
  input: BuscarPoliticaComercialInput,
): Promise<PoliticaComercial[]> {
  const parsed = buscarPoliticaComercialInputSchema.parse(input);
  const values: unknown[] = [parsed.environment];
  let keyFilter = '';
  if (parsed.policy_keys && parsed.policy_keys.length > 0) {
    values.push(parsed.policy_keys);
    keyFilter = `AND policy_key = ANY($${values.length})`;
  }

  const result = await client.query<PolicyRow>(
    `SELECT DISTINCT ON (policy_key)
            policy_key, policy_value, description, policy_version
     FROM commerce.store_policies
     WHERE environment = $1
       AND is_active = true
       ${keyFilter}
     ORDER BY policy_key, updated_at DESC`,
    values,
  );

  return result.rows.flatMap((row) => {
    if (!isKnownPolicyKey(row.policy_key)) {
      logger.warn({ policy_key: row.policy_key }, 'atendente_unsupported_policy_key');
      return [];
    }
    return [
      {
        ...row,
        policy_value: parsePolicyValue(row.policy_key, row.policy_value),
      },
    ];
  });
}

function mapProdutoOferta(row: ProductFullRow): ProdutoOferta {
  return {
    ...row,
    total_stock_available: Number(row.total_stock_available ?? 0),
  };
}

function mapCompatibleTire(row: CompatibleTireRow): CompatibilidadeResultado['produtos'][number] {
  const position = row.position ?? row.fitment_position;
  const source = row.source ?? row.fitment_source;
  if (!position) throw new Error('find_compatible_tires returned no position column');
  if (!source) throw new Error('find_compatible_tires returned no source column');
  return {
    product_id: row.product_id,
    product_name: row.product_name,
    brand: row.brand,
    tire_size: row.tire_size,
    position,
    is_oem: row.is_oem,
    source,
    confidence_level: row.confidence_level,
    current_price: row.current_price,
    total_stock: Number(row.total_stock),
  };
}

function normalizeTireSize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '').replace(/r/g, '-');
}
