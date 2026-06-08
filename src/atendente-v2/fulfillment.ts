/**
 * Fundação do roteamento bot → unidade (Fase 0).
 *
 * Ver docs/SISTEMA_ANTIFRAUDE_REDE_2026-06-02.md §3.5.
 *
 * Duas peças, ambas SELECT puro (sem efeito colateral), pensadas como COSTURAS
 * pros upgrades posteriores:
 *
 *  1. resolveUnitForOrder() — decide QUAL loja atende/entrega o pedido do bot.
 *     Fase 0: única unidade ativa. Fase 2: geo ∩ estoque ∩ ranking — trocar só
 *     a regra interna, sem mexer em quem chama.
 *
 *  2. mapProductToPartnerStock() — casa o produto do catálogo central com a
 *     linha de estoque DA LOJA (partner_stock_levels) + o preço CENTRAL tabelado
 *     (commerce.product_prices). Decisão de negócio (Wallace, 2026-06-02):
 *     estoque = da loja; preço = tabelado central igual pra todas as unidades.
 *
 * Nada aqui escreve. A materialização do partner_order (com reserva de estoque)
 * é feita no criar_pedido reusando commerce.register_partner_local_order.
 */

import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';
import type { PartnerContext } from '../parceiro/auth.js';
import { upsertPartnerCustomerWithClient } from '../parceiro/queries.js';
import { logger } from '../shared/logger.js';
import { env } from '../shared/config/env.js';
import { rankUnitsByFairnessFromDb } from './fairness.js';
import { haversineKm, type GeoPoint } from '../shared/geo/haversine.js';
import { GEO_PICKUP_RADIUS_KM, GEO_RING_KM, selectWithinExpandingRing } from '../shared/geo/ring.js';
import { roadDistanceKm } from '../shared/geo/google-maps.js';
import { filterByModeAndCoverage, ringsForModalidade, type GeoRoutingCandidate } from './geo-routing.js';

interface RoutedUnitRow {
  partner_unit_id: string;
  unit_id: string;
  partner_id: string;
  slug: string;
  partner_name: string;
  unit_name: string;
}

/**
 * Resolve a unidade (loja) que vai atender/entregar o pedido do bot e devolve
 * um PartnerContext pronto pra reusar as funções do Portal Parceiro.
 *
 * FASE 0: retorna a ÚNICA unidade ativa da rede (parceiro + unidade `active`,
 * não deletada). Se houver mais de uma ativa, pega a mais antiga de forma
 * determinística e loga um aviso — sinal de que o roteamento multi-loja
 * (Fase 2) precisa ser implementado.
 *
 * Retorna null se NÃO houver unidade ativa — o chamador decide o fallback
 * (ex.: criar_pedido não materializa partner_order, só grava commerce.orders).
 */
export async function resolveUnitForOrder(
  client: PoolClient,
  environment: Environment,
): Promise<PartnerContext | null> {
  const result = await client.query<RoutedUnitRow>(
    `SELECT pu.id            AS partner_unit_id,
            pu.unit_id       AS unit_id,
            p.id             AS partner_id,
            pu.slug          AS slug,
            p.trade_name     AS partner_name,
            COALESCE(pu.display_name, u.name) AS unit_name
     FROM network.partner_units pu
     JOIN network.partners p ON p.id = pu.partner_id AND p.environment = pu.environment
     JOIN core.units u ON u.id = pu.unit_id
     WHERE pu.environment = $1
       AND pu.status = 'active'
       AND p.status = 'active'
       AND pu.deleted_at IS NULL
       AND p.deleted_at IS NULL
     ORDER BY pu.created_at ASC
     LIMIT 2`,
    [environment],
  );

  if (result.rowCount === 0) {
    logger.warn({ environment }, 'resolveUnitForOrder: nenhuma unidade ativa — pedido do bot fica sem loja');
    return null;
  }
  if (result.rowCount && result.rowCount > 1) {
    logger.warn(
      { environment },
      'resolveUnitForOrder: >1 unidade ativa, mas roteamento multi-loja (Fase 2) ainda não implementado — pegando a mais antiga',
    );
  }

  const row = result.rows[0]!;
  return {
    environment,
    partnerId: row.partner_id,
    partnerUnitId: row.partner_unit_id,
    unitId: row.unit_id,
    slug: row.slug,
    partnerName: row.partner_name,
    unitName: row.unit_name,
    // O bot age como ator de sistema (cria pedido em nome da loja): autoridade total.
    role: 'owner',
    // Ator de sistema: não tem login/token real (nunca chama set-credentials).
    tokenId: '',
  };
}

/**
 * Resolve a unidade parceira que COBRE o município (Etapa 1 onboarding 2026-06-04):
 * a cobertura vem da tabela `network.unit_coverage`, não mais de PARTNER_COVERAGE
 * hardcoded. Já é multi-parceiro: adicionar parceiro numa região = inserir linha de
 * cobertura. Match: o município do cliente CONTÉM a área coberta (mesma régua do antigo
 * partnerCoversRegion). Empate → cobertura mais específica, depois parceiro mais antigo.
 * Retorna null se nenhum parceiro ativo cobre o município.
 */
export async function resolveUnitForMunicipio(
  client: PoolClient,
  environment: Environment,
  municipio: string | null | undefined,
): Promise<PartnerContext | null> {
  const m = normalizeRegion(municipio);
  if (!m) return null;
  const result = await client.query<RoutedUnitRow>(
    `SELECT pu.id            AS partner_unit_id,
            pu.unit_id       AS unit_id,
            p.id             AS partner_id,
            pu.slug          AS slug,
            p.trade_name     AS partner_name,
            COALESCE(pu.display_name, u.name) AS unit_name
     FROM network.unit_coverage uc
     JOIN network.partner_units pu ON pu.unit_id = uc.unit_id AND pu.environment = uc.environment
     JOIN network.partners p ON p.id = pu.partner_id AND p.environment = pu.environment
     JOIN core.units u ON u.id = pu.unit_id
     WHERE uc.environment = $1
       AND $2 LIKE '%' || uc.municipio || '%'
       AND pu.status = 'active'
       AND p.status = 'active'
       AND pu.deleted_at IS NULL
       AND p.deleted_at IS NULL
     ORDER BY length(uc.municipio) DESC, pu.created_at ASC
     LIMIT 1`,
    [environment, m],
  );

  const row = result.rows[0];
  if (!row) return null;
  return {
    environment,
    partnerId: row.partner_id,
    partnerUnitId: row.partner_unit_id,
    unitId: row.unit_id,
    slug: row.slug,
    partnerName: row.partner_name,
    unitName: row.unit_name,
    // O bot age como ator de sistema (cria pedido em nome da loja): autoridade total.
    role: 'owner',
    // Ator de sistema: não tem login/token real (nunca chama set-credentials).
    tokenId: '',
  };
}

export interface UnitCandidate {
  ctx: PartnerContext;
  /** Modo de atendimento da loja (network.partner_units.service_mode). */
  serviceMode: 'delivery' | 'pickup' | 'both';
  /** Coordenada da loja (network.partner_units lat/long); null = não cadastrada. */
  location: GeoPoint | null;
  /** Cobre a CIDADE inteira? (alguma linha de cobertura kind='city' p/ o município). */
  hasCityCoverage: boolean;
  /** Bairros declarados (unit_coverage kind='neighborhood'). */
  neighborhoods: string[];
}

/**
 * Fase 2: lista TODAS as unidades parceiras que cobrem o município — sem `LIMIT 1`,
 * ao contrário de `resolveUnitForMunicipio`. Cada candidato traz o `service_mode`
 * pro filtro de modalidade. A ORDEM aqui não importa (a régua de justiça reordena
 * depois); só precisa ser determinística. Dedup por unidade (uma loja pode cobrir
 * cidade + bairro). Só parceiros/unidades ativos. Retorna [] se ninguém cobre.
 *
 * v1 = por MUNICÍPIO (mesma régua de cobertura de hoje). Cobertura por BAIRRO
 * (`neighborhood_canonical`, bairro vence cidade) é a flag ROUTING_NEIGHBORHOOD,
 * peça separada da Fase 2.
 */
export async function resolveUnitCandidates(
  client: PoolClient,
  environment: Environment,
  municipio: string | null | undefined,
): Promise<UnitCandidate[]> {
  const m = normalizeRegion(municipio);
  if (!m) return [];
  // GROUP BY pelas PKs (pu.id/p.id/u.id) → dependência funcional cobre as demais
  // colunas. Agrega a cobertura DO MUNICÍPIO casado: has_city_coverage (alguma linha
  // city) + neighborhoods (bairros declarados). lat/long vêm da unidade (0088).
  const result = await client.query<
    RoutedUnitRow & {
      service_mode: string;
      latitude: string | null;
      longitude: string | null;
      has_city_coverage: boolean;
      neighborhoods: (string | null)[] | null;
    }
  >(
    `SELECT pu.id            AS partner_unit_id,
            pu.unit_id       AS unit_id,
            p.id             AS partner_id,
            pu.slug          AS slug,
            p.trade_name     AS partner_name,
            COALESCE(pu.display_name, u.name) AS unit_name,
            pu.service_mode  AS service_mode,
            pu.latitude      AS latitude,
            pu.longitude     AS longitude,
            bool_or(uc.coverage_kind = 'city')                  AS has_city_coverage,
            array_remove(array_agg(uc.neighborhood_canonical), NULL) AS neighborhoods
     FROM network.unit_coverage uc
     JOIN network.partner_units pu ON pu.unit_id = uc.unit_id AND pu.environment = uc.environment
     JOIN network.partners p ON p.id = pu.partner_id AND p.environment = pu.environment
     JOIN core.units u ON u.id = pu.unit_id
     WHERE uc.environment = $1
       AND $2 LIKE '%' || uc.municipio || '%'
       AND pu.status = 'active'
       AND p.status = 'active'
       AND pu.deleted_at IS NULL
       AND p.deleted_at IS NULL
     GROUP BY pu.id, p.id, u.id
     ORDER BY pu.id`,
    [environment, m],
  );

  return result.rows.map((row) => ({
    ctx: {
      environment,
      partnerId: row.partner_id,
      partnerUnitId: row.partner_unit_id,
      unitId: row.unit_id,
      slug: row.slug,
      partnerName: row.partner_name,
      unitName: row.unit_name,
      role: 'owner',
      tokenId: '',
    },
    serviceMode: (row.service_mode as UnitCandidate['serviceMode']) ?? 'both',
    location:
      row.latitude != null && row.longitude != null
        ? { lat: Number(row.latitude), lng: Number(row.longitude) }
        : null,
    hasCityCoverage: row.has_city_coverage ?? false,
    neighborhoods: (row.neighborhoods ?? []).filter((n): n is string => typeof n === 'string' && n.length > 0),
  }));
}

/**
 * Resolve o `unit_id` da MATRIZ (loja própria do dono, `slug='main'`). Usado pra
 * carimbar `commerce.orders.unit_id` nas vendas da matriz (ETAPA 1 / Fase 0a).
 * Retorna null se não achar (defensivo — o INSERT mantém unit_id NULL, como hoje).
 */
export async function resolveMatrizUnitId(
  client: PoolClient,
  environment: Environment,
): Promise<string | null> {
  const r = await client.query<{ id: string }>(
    `SELECT id FROM core.units WHERE environment = $1 AND slug = 'main' LIMIT 1`,
    [environment],
  );
  return r.rows[0]?.id ?? null;
}

/**
 * Resolve o município (cidade) a partir do geo_resolution_id que o `calcular_frete`
 * produziu, pra alimentar o roteamento. Tolera ausência (pickup / sem geo / id órfão)
 * → devolve null, e o chamador trata como "sem região" (cai na matriz).
 */
export async function resolveMunicipioFromGeo(
  client: PoolClient,
  environment: Environment,
  geoResolutionId: string,
): Promise<string | null> {
  const r = await client.query<{ city_name: string }>(
    `SELECT city_name FROM commerce.geo_resolutions WHERE environment = $1 AND id = $2 LIMIT 1`,
    [environment, geoResolutionId],
  );
  const city = r.rows[0]?.city_name ?? null;
  if (!city) {
    logger.warn({ environment, geoResolutionId }, 'resolveMunicipioFromGeo: geo_resolution_id não encontrado — cai na matriz');
  }
  return city;
}

export interface PartnerStockMapping {
  /** commerce.partner_stock_levels.id da unidade — alvo da reserva de estoque. */
  partner_stock_id: string;
  /** Preço CENTRAL tabelado (commerce.product_prices), não o sale_price da loja. */
  central_price: number;
  /** Nome do item no estoque da loja (pra logs/itens). */
  item_name: string;
}

/**
 * Mapeia um produto do catálogo central (commerce.products.id) para:
 *  - a linha de estoque DA LOJA (commerce.partner_stock_levels) daquela unidade;
 *  - o preço CENTRAL tabelado vigente (commerce.product_prices, price_type='regular').
 *
 * Retorna null se a unidade NÃO estoca o produto (item indisponível na loja) ou
 * se não houver preço central vigente. A validação de quantidade suficiente fica
 * a cargo de commerce.register_partner_local_order (levanta 'Estoque insuficiente').
 */
export async function mapProductToPartnerStock(
  client: PoolClient,
  environment: Environment,
  unitId: string,
  productId: string,
  neededQty = 1,
): Promise<PartnerStockMapping | null> {
  // H5 (revisão multi-agente): só casa estoque RASTREADO e com DISPONÍVEL suficiente
  // (disponível = quantity_on_hand − quantity_reserved, igual à máquina em 0076). Linha
  // não-rastreada / on_hand NULL = "vende no escuro" → NÃO roteia pro parceiro (vai matriz).
  const stock = await client.query<{ id: string; item_name: string }>(
    `SELECT id, item_name
     FROM commerce.partner_stock_levels
     WHERE environment = $1
       AND unit_id = $2
       AND product_id = $3
       AND deleted_at IS NULL
       AND is_tracked = true
       AND quantity_on_hand IS NOT NULL
       AND (quantity_on_hand - COALESCE(quantity_reserved, 0)) >= $4
     ORDER BY (quantity_on_hand - COALESCE(quantity_reserved, 0)) DESC
     LIMIT 1`,
    [environment, unitId, productId, neededQty],
  );
  if (stock.rowCount === 0) return null;

  const price = await client.query<{ price_amount: string }>(
    `SELECT price_amount
     FROM commerce.product_prices
     WHERE environment = $1
       AND product_id = $2
       AND price_type = 'regular'
       AND valid_from <= now()
       AND (valid_until IS NULL OR valid_until > now())
     ORDER BY valid_from DESC
     LIMIT 1`,
    [environment, productId],
  );
  if (price.rowCount === 0) {
    logger.warn({ environment, unitId, productId }, 'mapProductToPartnerStock: estoque ok mas SEM preço central vigente — fallback matriz');
    return null;
  }

  return {
    partner_stock_id: stock.rows[0]!.id,
    central_price: Number(price.rows[0]!.price_amount),
    item_name: stock.rows[0]!.item_name,
  };
}

export interface StoreDecision {
  store: 'matriz' | 'partner';
  unit_id: string;
  unit_label: string;
  /** Presente só quando store==='partner' — contexto pronto pra materializar o partner_order. */
  partner?: PartnerContext;
  /** Presente só quando store==='partner' — alvo da reserva + preço central. */
  partner_stock_id?: string;
  central_price?: number;
  /** A loja escolhida tem o produto em estoque? */
  has_stock: boolean;
  /** Explicação legível da decisão (pra logs/depuração/prova). */
  reason: string;
}

/**
 * Cobertura por loja (ETAPA 2). Decisão Wallace 2026-06-02:
 *  - cada parceiro cobre uma lista de municípios;
 *  - a MATRIZ cobre TUDO (fallback universal — se nenhum parceiro cobre, é matriz);
 *  - frete fixo da rede = R$ 9,90 pra todos (ver FRETE_PADRAO_BRL).
 *
 * Hoje em config (1 parceiro ativo). COSTURA: quando houver vários parceiros,
 * isto vira a tabela `network.unit_coverage` (unit_id → áreas) sem mudar a
 * assinatura de `decideStoreForOrder`.
 */
// PARTNER_COVERAGE saiu daqui (Etapa 1 onboarding 2026-06-04): cobertura agora vem da
// tabela network.unit_coverage, via resolveUnitForMunicipio. Adicionar parceiro = inserir linha.

/** Frete fixo da rede (decisão Wallace 2026-06-02): R$ 9,90 pra todos. */
export const FRETE_PADRAO_BRL = 9.9;

export function normalizeRegion(s: string | null | undefined): string {
  return (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

// partnerCoversRegion saiu daqui: a cobertura agora é resolvida por resolveUnitForMunicipio
// (lê network.unit_coverage). normalizeRegion continua em uso lá.

/** Resolve o município canônico a partir do bairro (mesma fonte do calcular_frete). */
export async function resolveMunicipioFromBairro(
  client: PoolClient,
  environment: Environment,
  bairro: string,
  municipio?: string | null,
): Promise<string | null> {
  const r = await client.query<{ city_name: string | null }>(
    `SELECT city_name FROM commerce.resolve_neighborhood($1, $2, $3) LIMIT 1`,
    [environment, bairro, municipio ?? null],
  );
  return r.rows[0]?.city_name ?? null;
}

/**
 * Localização da loja que atende o cliente: nome + endereço escrito + horário + link do Google Maps
 * (network.partner_units, editado pelo dono na tela Dados da loja). Resolve a unidade pelo município
 * (do bairro, se preciso). Quando VÁRIAS lojas cobrem o município, escolhe a MAIS PERTO do cliente
 * (haversine sobre a coordenada do cliente — pino ou geocode do bairro), NÃO a mais antiga. Sem
 * coordenada e com várias lojas → null (o bot pergunta o bairro/pino). SEM município só devolve loja
 * se houver UMA única unidade ativa (mono-loja); com várias → null. NUNCA chuta a mais antiga (senão
 * indicaria a loja errada, ex.: Copacabana pra quem é de Bangu, ou Itaboraí pra quem é de Copacabana).
 * endereço/horário/maps_url podem ser null (dono ainda não preencheu). Retorna null se não há loja resolvível.
 */
export async function getUnitMapsUrl(
  client: PoolClient,
  environment: Environment,
  opts: { bairro?: string | null; municipio?: string | null; customerLocation?: GeoPoint | null; productIds?: string[] },
): Promise<{ nome_loja: string; maps_url: string | null; address: string | null; opening_hours: string | null } | null> {
  let municipio = opts.municipio ?? null;
  if (!municipio && opts.bairro) {
    municipio = await resolveMunicipioFromBairro(client, environment, opts.bairro);
  }
  const m = normalizeRegion(municipio);
  const cols =
    'pu.unit_id AS unit_id, COALESCE(pu.display_name, u.name) AS nome_loja, pu.maps_url, pu.address, pu.opening_hours_text AS opening_hours, pu.latitude, pu.longitude';
  type MapsRow = {
    unit_id: string;
    nome_loja: string; maps_url: string | null; address: string | null; opening_hours: string | null;
    latitude: string | number | null; longitude: string | number | null;
  };
  const strip = (r: MapsRow) => ({ nome_loja: r.nome_loja, maps_url: r.maps_url, address: r.address, opening_hours: r.opening_hours });

  if (m) {
    // TODAS as lojas ativas que cobrem o município (não LIMIT 1 pela mais antiga).
    const r = await client.query<MapsRow>(
      `SELECT ${cols}
         FROM network.unit_coverage uc
         JOIN network.partner_units pu ON pu.unit_id = uc.unit_id AND pu.environment = uc.environment
         JOIN network.partners p ON p.id = pu.partner_id AND p.environment = pu.environment
         JOIN core.units u ON u.id = pu.unit_id
        WHERE uc.environment = $1
          AND $2 LIKE '%' || uc.municipio || '%'
          AND pu.status = 'active' AND p.status = 'active'
          AND pu.deleted_at IS NULL AND p.deleted_at IS NULL
        ORDER BY length(uc.municipio) DESC, pu.created_at ASC`,
      [environment, m],
    );
    let rows = r.rows;
    // Ciente de ESTOQUE (decisão Wallace 2026-06-08): com produto conhecido, só indica
    // loja que TEM o(s) item(ns) ATIVO(s) — respeita deleted_at, igual ao pedido. Nenhuma
    // loja perto com o produto → null (o bot é honesto, não chuta a mais perto sem estoque).
    if (opts.productIds && opts.productIds.length > 0) {
      const st = await client.query<{ unit_id: string }>(
        `SELECT unit_id
           FROM commerce.partner_stock_levels
          WHERE environment = $1 AND unit_id = ANY($2) AND product_id = ANY($3)
            AND deleted_at IS NULL AND is_tracked = true AND quantity_on_hand IS NOT NULL
            AND (quantity_on_hand - COALESCE(quantity_reserved, 0)) > 0
          GROUP BY unit_id
          HAVING COUNT(DISTINCT product_id) = $4`,
        [environment, rows.map((x) => x.unit_id), opts.productIds, opts.productIds.length],
      );
      const inStock = new Set(st.rows.map((x) => x.unit_id));
      rows = rows.filter((x) => inStock.has(x.unit_id));
      if (rows.length === 0) return null;
    }
    if (rows.length === 1) return strip(rows[0]!);
    if (rows.length > 1) {
      // VÁRIAS lojas cobrem o município → a MAIS PERTO do cliente por ESTRADA (igual ao
      // pedido/busca — decisão Wallace 2026-06-08: cálculo de rua, não linha reta. De Bangu
      // a Barra é perto em reta mas LONGE de carro; o Méier é o mais perto de rua). Sem
      // coordenada do cliente → null (o bot pergunta o bairro/pino).
      const origin = opts.customerLocation;
      if (!origin) return null;
      const withCoords = rows
        .map((row) => {
          const lat = row.latitude == null ? NaN : Number(row.latitude);
          const lng = row.longitude == null ? NaN : Number(row.longitude);
          return Number.isFinite(lat) && Number.isFinite(lng) ? { row, location: { lat, lng } as GeoPoint } : null;
        })
        .filter((x): x is { row: MapsRow; location: GeoPoint } => x != null);
      if (withCoords.length === 0) return null; // nenhuma loja com coordenada → não chuta
      const dist = await resolveDistances(origin, withCoords.map((x) => ({ unitId: x.row.unit_id, location: x.location })));
      const ranked = withCoords
        .map((x) => ({ row: x.row, km: dist.get(x.row.unit_id) ?? Infinity }))
        .sort((a, b) => a.km - b.km);
      return strip(ranked[0]!.row);
    }
    // rows.length === 0 → cai pro fallback de mono-loja abaixo.
  }

  // SEM município (ou sem cobertura casada): só cai pra "a loja" se houver EXATAMENTE UMA unidade
  // ativa (mono-loja). Com várias lojas NÃO se chuta — null pra o bot perguntar o bairro.
  const r = await client.query<MapsRow>(
    `SELECT ${cols}
       FROM network.partner_units pu
       JOIN network.partners p ON p.id = pu.partner_id AND p.environment = pu.environment
       JOIN core.units u ON u.id = pu.unit_id
      WHERE pu.environment = $1
        AND pu.status = 'active' AND p.status = 'active'
        AND pu.deleted_at IS NULL AND p.deleted_at IS NULL
      ORDER BY pu.created_at ASC
      LIMIT 2`,
    [environment],
  );
  if (r.rowCount === 1) return strip(r.rows[0]!);
  return null;
}

/**
 * Mapa product_id → quantidade DISPONÍVEL no parceiro que cobre `municipio`
 * (vazio se não há parceiro/cobertura). Mesma régua de disponível do roteamento
 * (H5: rastreado + on_hand−reserved). Usado pelo C2 pra as buscas mostrarem o
 * estoque da loja que VAI atender, sem duplicar a lógica de cobertura.
 */
export async function getPartnerStockMap(
  client: PoolClient,
  environment: Environment,
  municipio: string | null,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!municipio) return map;
  const partner = await resolveUnitForMunicipio(client, environment, municipio);
  if (!partner) return map;
  const r = await client.query<{ product_id: string; disponivel: string }>(
    `SELECT product_id, (quantity_on_hand - COALESCE(quantity_reserved, 0))::text AS disponivel
     FROM commerce.partner_stock_levels
     WHERE environment = $1
       AND unit_id = $2
       AND product_id IS NOT NULL
       AND deleted_at IS NULL
       AND is_tracked = true
       AND quantity_on_hand IS NOT NULL
       AND (quantity_on_hand - COALESCE(quantity_reserved, 0)) > 0`,
    [environment, partner.unitId],
  );
  for (const row of r.rows) map.set(row.product_id, Number(row.disponivel));
  return map;
}

/**
 * O CÉREBRO do roteamento (ETAPA 0). Decide a loja por **região → estoque →
 * fallback matriz**:
 *  1. região: a loja que cobre o local do cliente (TESTE: parceiro=Itaboraí, matriz=resto);
 *  2. estoque: a loja candidata TEM o produto? (parceiro: partner_stock_levels; matriz: stock_levels);
 *  3. fallback: parceiro da região SEM o produto → vai pra matriz (a matriz é o backstop).
 *
 * Não escreve nada — só decide e explica. Materialização do pedido fica no criar_pedido.
 */
export async function decideStoreForOrder(
  client: PoolClient,
  environment: Environment,
  input: { municipio?: string | null; productId: string; quantity?: number },
): Promise<StoreDecision> {
  const partner = await resolveUnitForMunicipio(client, environment, input.municipio);

  const matrizRes = await client.query<{ id: string; name: string }>(
    `SELECT id, name FROM core.units WHERE environment = $1 AND slug = 'main' LIMIT 1`,
    [environment],
  );
  const matriz = matrizRes.rows[0];
  if (!matriz) throw new Error('Unidade matriz (slug=main) não encontrada');

  const matrizHasStock = async (pid: string): Promise<boolean> => {
    const r = await client.query<{ q: string }>(
      `SELECT COALESCE(quantity_available, 0)::text AS q
       FROM commerce.stock_levels
       WHERE environment = $1 AND product_id = $2
       ORDER BY quantity_available DESC LIMIT 1`,
      [environment, pid],
    );
    return Number(r.rows[0]?.q ?? 0) > 0;
  };

  const toMatriz = async (reason: string): Promise<StoreDecision> => ({
    store: 'matriz',
    unit_id: matriz.id,
    unit_label: matriz.name,
    has_stock: await matrizHasStock(input.productId),
    reason,
  });

  // 1. Região do parceiro? (partner já vem resolvido pela cobertura do município)
  if (partner) {
    // 2. Parceiro tem o produto?
    const mapping = await mapProductToPartnerStock(client, environment, partner.unitId, input.productId, input.quantity ?? 1);
    if (mapping) {
      return {
        store: 'partner',
        unit_id: partner.unitId,
        unit_label: partner.unitName,
        partner,
        partner_stock_id: mapping.partner_stock_id,
        central_price: mapping.central_price,
        has_stock: true,
        reason: `região do parceiro (${input.municipio}) + parceiro tem o produto`,
      };
    }
    // 3. Fallback: parceiro sem o produto → matriz (backstop)
    return toMatriz(`região do parceiro (${input.municipio}) mas parceiro SEM o produto → fallback matriz`);
  }

  // Fora da região do parceiro (ou sem parceiro ativo) → matriz
  return toMatriz(partner ? 'fora da região do parceiro → matriz' : 'sem parceiro ativo → matriz');
}

export interface ItemForDecision {
  product_id: string;
  quantity: number;
}

/** Roteamento resolvido pro parceiro (ou `null` = matriz). */
export interface PartnerOrderRouting {
  ctx: NonNullable<StoreDecision['partner']>;
  unitId: string;
  items: { product_id: string; partner_stock_id: string; quantity: number; central_price: number }[];
}

/**
 * Decisão de loja para um CONJUNTO de itens de entrega — FONTE ÚNICA, usada tanto
 * pelo `criar_pedido` (registro) quanto pelo `calcular_frete` (cotação), pra a FALA e
 * o REGISTRO nunca divergirem. Regra (H4/H5): exige município conhecido e só vai pro
 * parceiro se TODOS os itens caem no MESMO parceiro com estoque disponível; senão
 * `null` (= matriz, o backstop).
 */
export async function decideStoreForItems(
  client: PoolClient,
  environment: Environment,
  input: { municipio: string | null; items: ItemForDecision[] },
): Promise<PartnerOrderRouting | null> {
  if (!input.municipio || input.items.length === 0) return null;

  // Fase 2: motor multi-parceiro (flag). DESLIGADA = caminho de hoje (abaixo), intocado.
  if (env.ROUTING_MULTI_CANDIDATE) {
    return decideStoreForItemsMulti(client, environment, {
      municipio: input.municipio,
      items: input.items,
    });
  }

  const decisions = await Promise.all(
    input.items.map((i) =>
      decideStoreForOrder(client, environment, {
        municipio: input.municipio,
        productId: i.product_id,
        quantity: i.quantity,
      }),
    ),
  );

  const allPartner = decisions.every(
    (d) => d.store === 'partner' && d.partner && d.partner_stock_id && d.central_price != null,
  );
  const oneUnit = new Set(decisions.map((d) => d.unit_id)).size === 1;
  if (!allPartner || !oneUnit) return null;

  return {
    ctx: decisions[0]!.partner!,
    unitId: decisions[0]!.unit_id,
    items: input.items.map((i, idx) => ({
      product_id: i.product_id,
      partner_stock_id: decisions[idx]!.partner_stock_id!,
      quantity: i.quantity,
      central_price: decisions[idx]!.central_price!,
    })),
  };
}

/**
 * Fase 2 — motor multi-parceiro (atrás de ROUTING_MULTI_CANDIDATE). Considera
 * TODOS os parceiros que cobrem o município (`resolveUnitCandidates`, sem LIMIT 1),
 * ordena pela régua de justiça (se ROUTING_FAIRNESS ligada) e tenta cada um na
 * ordem: o 1º que tem TODOS os itens em estoque vence. Se nenhum tem → null
 * (matriz). Implementa a decisão #1 (tenta o 2º antes da matriz).
 *
 * Determinístico, sem escrita. Reusa `mapProductToPartnerStock` (mesma régua de
 * estoque disponível do caminho de hoje), então a decisão de estoque é idêntica.
 */
async function decideStoreForItemsMulti(
  client: PoolClient,
  environment: Environment,
  input: { municipio: string; items: ItemForDecision[] },
): Promise<PartnerOrderRouting | null> {
  const candidates = await resolveUnitCandidates(client, environment, input.municipio);
  if (candidates.length === 0) return null; // ninguém cobre → matriz

  // v1: este caminho é sempre contexto de ENTREGA (calcular_frete / criar_pedido
  // delivery — pickup ainda cai na matriz antes daqui). Loja só-retirada não atende
  // entrega → filtra. O fio do `intent` genérico + a flag ROUTING_MODE_FILTER vêm
  // no próximo tijolo; este filtro é o default seguro pra não escolher pickup-only.
  const eligible = candidates.filter((c) => c.serviceMode !== 'pickup');
  if (eligible.length === 0) return null;

  const byUnit = new Map(eligible.map((c) => [c.ctx.unitId, c]));
  const orderedUnitIds = env.ROUTING_FAIRNESS
    ? await rankUnitsByFairnessFromDb(client, environment, eligible.map((c) => c.ctx.unitId))
    : eligible.map((c) => c.ctx.unitId);

  for (const unitId of orderedUnitIds) {
    const cand = byUnit.get(unitId);
    if (!cand) continue;
    const mappings = await Promise.all(
      input.items.map((i) =>
        mapProductToPartnerStock(client, environment, cand.ctx.unitId, i.product_id, i.quantity),
      ),
    );
    if (mappings.every((m) => m != null)) {
      logger.info(
        { environment, unit_id: cand.ctx.unitId, candidatos: orderedUnitIds.length, fairness: env.ROUTING_FAIRNESS },
        'decideStoreForItemsMulti: parceiro escolhido pela régua (Fase 2)',
      );
      return {
        ctx: cand.ctx,
        unitId: cand.ctx.unitId,
        items: input.items.map((i, idx) => ({
          product_id: i.product_id,
          partner_stock_id: mappings[idx]!.partner_stock_id,
          quantity: i.quantity,
          central_price: mappings[idx]!.central_price,
        })),
      };
    }
    // candidato sem todos os itens → tenta o próximo (decisão #1)
  }
  return null; // nenhum candidato da área tem o pedido completo → matriz
}

// ─── CAMADA GEO (proximidade) ────────────────────────────────────────────────
// Ver docs/PLANO_CAMADA_GEO_PROXIMIDADE_REDE_2026-06-06.md §5.6.
// Versão do motor multi-parceiro com FILTRO DE ANEL (km que cresce) antes da régua
// de justiça. ADITIVA: não altera decideStoreForItems/Multi de hoje — as tools
// chamam esta função só quando ROUTING_GEO está ligada E há coordenada do cliente
// (Fase 4). Sem coordenada o caminho de hoje (por cidade) continua valendo (caso F).

export interface GeoDecisionInput {
  municipio: string;
  items: ItemForDecision[];
  modalidade: 'delivery' | 'pickup';
  /** Coordenada do cliente (pino ou endereço geocodado). */
  customerLocation: GeoPoint;
  /** Bairro canônico do cliente (p/ a cobertura 4a na entrega); null = desconhecido. */
  clientNeighborhoodCanonical: string | null;
}

export type GeoStoreDecision =
  | { kind: 'partner'; routing: PartnerOrderRouting; ringKm: number | null; distanceKm: number }
  | { kind: 'only_far'; unitId: string; unitName: string; distanceKm: number }
  | { kind: 'matriz' };

function toGeoRoutingCandidate(c: UnitCandidate): GeoRoutingCandidate {
  return {
    unitId: c.ctx.unitId,
    serviceMode: c.serviceMode,
    location: c.location,
    hasCityCoverage: c.hasCityCoverage,
    neighborhoods: c.neighborhoods,
  };
}

/**
 * Distância (km) do cliente a cada loja. Linha reta (haversine) SEMPRE como base e
 * rede de segurança; se ROUTING_GEO_ROAD_DISTANCE + chave, sobrepõe com a distância
 * de RUA do Google por loja (null daquele trecho → mantém o haversine — caso H/D5).
 */
async function resolveDistances(
  origin: GeoPoint,
  units: { unitId: string; location: GeoPoint }[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  for (const u of units) map.set(u.unitId, haversineKm(origin, u.location));

  if (env.ROUTING_GEO_ROAD_DISTANCE && env.GOOGLE_MAPS_API_KEY && units.length > 0) {
    const road = await roadDistanceKm(origin, units.map((u) => u.location), env.GOOGLE_MAPS_API_KEY);
    if (road) {
      road.forEach((km, i) => {
        if (km != null) map.set(units[i]!.unitId, km);
      });
    }
  }
  return map;
}

/**
 * Decisão de loja por PROXIMIDADE. Pipeline (§3):
 *  ② modo + ④a cobertura (puro) → ③ estoque completo (DB) → ④b/④c anel que cresce
 *  → ⑤ régua de justiça entre o pool. Reusa mapProductToPartnerStock (mesma régua de
 *  estoque de hoje) e rankUnitsByFairnessFromDb (a régua, intocada).
 *
 * Retorna:
 *  - partner   → loja escolhida dentro do anel (com o pedido completo);
 *  - only_far  → ninguém no anel, mas EXISTE loja com o pedido completo além do maior
 *                anel (caso E, honestidade D3) — a mais perto dos longes;
 *  - matriz    → ninguém cobre / ninguém tem o pedido completo (backstop).
 */
export async function decideStoreForItemsGeo(
  client: PoolClient,
  environment: Environment,
  input: GeoDecisionInput,
): Promise<GeoStoreDecision> {
  if (input.items.length === 0) return { kind: 'matriz' };

  const candidates = await resolveUnitCandidates(client, environment, input.municipio);
  if (candidates.length === 0) return { kind: 'matriz' };

  // ② modo + ④a cobertura (puro, de graça) — reduz as checagens de estoque.
  const servableIds = new Set(
    filterByModeAndCoverage(
      candidates.map(toGeoRoutingCandidate),
      input.modalidade,
      input.clientNeighborhoodCanonical,
    ).map((c) => c.unitId),
  );

  // ③ estoque: só entra no anel quem tem TODOS os itens disponíveis E tem coordenada.
  const fulfillable: { cand: UnitCandidate; mappings: PartnerStockMapping[]; distanceKm: number }[] = [];
  const eligible = candidates.filter((c) => servableIds.has(c.ctx.unitId) && c.location != null);
  if (eligible.length === 0) return { kind: 'matriz' };

  const distanceByUnit = await resolveDistances(
    input.customerLocation,
    eligible.map((c) => ({ unitId: c.ctx.unitId, location: c.location! })),
  );

  for (const cand of eligible) {
    const mappings = await Promise.all(
      input.items.map((i) => mapProductToPartnerStock(client, environment, cand.ctx.unitId, i.product_id, i.quantity)),
    );
    if (mappings.every((m) => m != null)) {
      fulfillable.push({
        cand,
        mappings: mappings as PartnerStockMapping[],
        distanceKm: distanceByUnit.get(cand.ctx.unitId)!,
      });
    }
  }
  if (fulfillable.length === 0) return { kind: 'matriz' };

  // ④b/④c anel que cresce (D1/D2) sobre os que têm o pedido completo.
  const rings = ringsForModalidade(input.modalidade, GEO_RING_KM, GEO_PICKUP_RADIUS_KM);
  const selection = selectWithinExpandingRing(fulfillable, (f) => f.distanceKm, rings);

  // ⑤ régua de justiça entre o pool (D4) — entre os perto o bastante, decide a justiça.
  if (selection.pool.length > 0) {
    const poolByUnit = new Map(selection.pool.map((f) => [f.cand.ctx.unitId, f]));
    const ordered = await rankUnitsByFairnessFromDb(client, environment, [...poolByUnit.keys()]);
    const winnerId = ordered.find((id) => poolByUnit.has(id)) ?? selection.pool[0]!.cand.ctx.unitId;
    const win = poolByUnit.get(winnerId)!;
    logger.info(
      { environment, unit_id: winnerId, ring_km: selection.ringKm, pool: selection.pool.length, modalidade: input.modalidade, road: env.ROUTING_GEO_ROAD_DISTANCE },
      'decideStoreForItemsGeo: loja escolhida no anel pela régua',
    );
    return {
      kind: 'partner',
      ringKm: selection.ringKm,
      distanceKm: win.distanceKm,
      routing: {
        ctx: win.cand.ctx,
        unitId: win.cand.ctx.unitId,
        items: input.items.map((i, idx) => ({
          product_id: i.product_id,
          partner_stock_id: win.mappings[idx]!.partner_stock_id,
          quantity: i.quantity,
          central_price: win.mappings[idx]!.central_price,
        })),
      },
    };
  }

  // caso E — só tem LONGE: existe loja com o pedido completo, mas além do maior anel.
  // onlyFar já vem ASC por km → a mais perto dos longes.
  const nearestFar = selection.onlyFar[0];
  if (nearestFar) {
    logger.info(
      { environment, unit_id: nearestFar.cand.ctx.unitId, distancia_km: Math.round(nearestFar.distanceKm), modalidade: input.modalidade },
      'decideStoreForItemsGeo: só tem longe (caso E)',
    );
    return { kind: 'only_far', unitId: nearestFar.cand.ctx.unitId, unitName: nearestFar.cand.ctx.unitName, distanceKm: nearestFar.distanceKm };
  }

  return { kind: 'matriz' };
}

/** Loja que vai atender um produto + quanto ela tem disponível. */
export interface ProductAvailability {
  unitId: string;
  available: number;
}

/**
 * Disponibilidade por PROXIMIDADE pra a BUSCA (buscar_produto / C2). Pra cada
 * `product_id`, acha a loja parceira MAIS PERTO do cliente — dentro do maior anel
 * de ENTREGA (régua D1, hoje 40 km) — que TEM o produto disponível, e devolve a
 * loja + a quantidade DELA.
 *
 * MESMA régua do `decideStoreForItemsGeo` (candidatos → modo+cobertura de entrega
 * → estoque → anel), só SEM a régua de justiça: a busca só responde "tem? quantos?"
 * e não materializa pedido, então basta a loja mais perto que tem (Madureira sem o
 * pneu → Méier → … até o teto).
 *
 * Produto SEM nenhuma loja em alcance NÃO entra no mapa → o chamador mantém o
 * estoque da MATRIZ (backstop: "acima do raio cai na matriz", decisão Wallace
 * 2026-06-08). Assim a busca nunca diverge do que o pedido vai fazer.
 */
export async function resolveProductAvailabilityByProximity(
  client: PoolClient,
  environment: Environment,
  input: {
    municipio: string | null;
    customerLocation: GeoPoint;
    clientNeighborhoodCanonical: string | null;
    productIds: string[];
  },
): Promise<Map<string, ProductAvailability>> {
  const out = new Map<string, ProductAvailability>();
  if (input.productIds.length === 0) return out;

  const candidates = await resolveUnitCandidates(client, environment, input.municipio);
  if (candidates.length === 0) return out;

  // modo (entrega) + cobertura declarada — MESMA porta do pedido de entrega.
  const servableIds = new Set(
    filterByModeAndCoverage(
      candidates.map(toGeoRoutingCandidate),
      'delivery',
      input.clientNeighborhoodCanonical,
    ).map((c) => c.unitId),
  );
  const eligible = candidates.filter((c) => servableIds.has(c.ctx.unitId) && c.location != null);
  if (eligible.length === 0) return out;

  // Distância de RUA (Google Distance Matrix) — a MESMA do pedido. Decisão Wallace
  // 2026-06-08: a busca usa o cálculo CORRETO (precisão acima de custo), pra a busca e o
  // pedido NUNCA divergirem. resolveDistances usa rua quando ROUTING_GEO_ROAD_DISTANCE +
  // chave (prod); sem isso degrada pra linha reta (haversine).
  const distanceByUnit = await resolveDistances(
    input.customerLocation,
    eligible.map((c) => ({ unitId: c.ctx.unitId, location: c.location! })),
  );
  const maxRing = Math.max(...GEO_RING_KM);

  // lojas dentro do teto, da MAIS PERTO pra mais longe.
  const inRange = eligible
    .filter((c) => (distanceByUnit.get(c.ctx.unitId) ?? Infinity) <= maxRing)
    .sort((a, b) => distanceByUnit.get(a.ctx.unitId)! - distanceByUnit.get(b.ctx.unitId)!);
  if (inRange.length === 0) return out;

  // estoque disponível por (unidade, produto) numa tacada (mesma régua do mapProductToPartnerStock).
  const stock = await client.query<{ unit_id: string; product_id: string; disponivel: string }>(
    `SELECT unit_id, product_id, (quantity_on_hand - COALESCE(quantity_reserved, 0))::text AS disponivel
     FROM commerce.partner_stock_levels
     WHERE environment = $1
       AND unit_id = ANY($2)
       AND product_id = ANY($3)
       AND deleted_at IS NULL
       AND is_tracked = true
       AND quantity_on_hand IS NOT NULL
       AND (quantity_on_hand - COALESCE(quantity_reserved, 0)) > 0`,
    [environment, inRange.map((c) => c.ctx.unitId), input.productIds],
  );
  const byUnit = new Map<string, Map<string, number>>();
  for (const r of stock.rows) {
    let m = byUnit.get(r.unit_id);
    if (!m) byUnit.set(r.unit_id, (m = new Map()));
    // unidade pode ter +1 linha pro mesmo produto → fica com o MAIOR disponível
    // (mesma escolha do mapProductToPartnerStock: ORDER BY disponivel DESC LIMIT 1).
    m.set(r.product_id, Math.max(m.get(r.product_id) ?? 0, Number(r.disponivel)));
  }

  // pra cada produto, a 1ª loja em alcance (mais perto) que tem ganha.
  for (const productId of input.productIds) {
    for (const c of inRange) {
      const q = byUnit.get(c.ctx.unitId)?.get(productId);
      if (q != null && q > 0) {
        out.set(productId, { unitId: c.ctx.unitId, available: q });
        break;
      }
    }
  }
  return out;
}

export interface BotPartnerOrderItem {
  partner_stock_id: string;
  quantity: number;
  unit_price: number;
}

export interface BotPartnerOrderInput {
  customer_name: string | null;
  customer_phone: string | null;
  items: BotPartnerOrderItem[];
  fulfillment_mode: 'delivery' | 'pickup';
  delivery_address: string | null;
  freight_amount: number;
  /** Chave idempotente estável por pedido do bot (evita duplicar em retry). */
  idempotency_key: string;
  /**
   * RETIRADA com reserva (decisão Wallace 2026-06-07): em vez de dar baixa física
   * no estoque (venda de balcão), RESERVA o pneu até o cliente retirar e NÃO abre
   * recebível (o dinheiro entra no "marcar retirado" do painel). Só no pickup do bot.
   */
  reserve_for_pickup?: boolean;
}

/**
 * Materializa o pedido do bot na MÁQUINA do parceiro (ETAPA 3), ATÔMICO no client
 * do bot (mesma transação — rollback desfaz tudo). REUSA o que já existe e funciona,
 * sem alterar a máquina do parceiro (só CHAMA as funções dela):
 *  - `upsertPartnerCustomerWithClient` → cliente em commerce.partner_customers;
 *  - `commerce.register_partner_local_order` → cria partner_order (status confirmed,
 *    delivery_status 'pending' = "Em separação"), RESERVA estoque, `source_tag='2w'`
 *    (= venda que o bot trouxe → base da comissão da matriz, já lida em getPainelRede);
 *  - COD: pagamento 'A receber' + conta a receber aberta (finance.partner_receivables,
 *    espelhando registerPartnerSale, vencimento na entrega).
 *
 * `register_partner_local_order` recebe `unit_id` EXPLÍCITO (não depende de GUC/RLS),
 * por isso roda direto no client do bot. Retorna o id do partner_order.
 */
export async function materializePartnerOrder(
  client: PoolClient,
  ctx: PartnerContext,
  input: BotPartnerOrderInput,
): Promise<{ partner_order_id: string; total_amount: string }> {
  const customerId = await upsertPartnerCustomerWithClient(client, ctx, {
    name: input.customer_name ?? '',
    phone: input.customer_phone,
    idempotency_key: `bot:${input.idempotency_key}:customer`,
  });

  const reg = await client.query<{ id: string }>(
    `SELECT commerce.register_partner_local_order(
       $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14
     ) AS id`,
    [
      ctx.environment,
      ctx.unitId,
      input.customer_name,
      input.customer_phone,
      JSON.stringify(input.items),
      'A receber', // COD — pago na entrega (ou no balcão, na retirada reservada)
      input.fulfillment_mode,
      input.delivery_address,
      `bot:${ctx.slug}`,
      input.idempotency_key,
      '2w', // source_tag — venda trazida pelo bot
      0, // discount
      input.freight_amount,
      input.reserve_for_pickup ?? false, // retirada reservada → reserva em vez de baixar
    ],
  );
  const orderId = reg.rows[0]!.id;

  // RETIRADA RESERVADA: marca "aguardando retirada" — o pneu fica segurado e o pedido
  // NÃO conta como venda realizada até o parceiro marcar retirado (mesma régua da
  // entrega não-entregue). Vira venda na data em que ele marcar (retrieved_at).
  if (input.reserve_for_pickup) {
    await client.query(
      `UPDATE commerce.partner_orders SET awaiting_pickup = true, updated_at = now()
       WHERE id = $1 AND environment = $2 AND unit_id = $3`,
      [orderId, ctx.environment, ctx.unitId],
    );
  }

  if (customerId) {
    await client.query(
      `UPDATE commerce.partner_orders SET customer_id = $4, updated_at = now()
       WHERE id = $1 AND environment = $2 AND unit_id = $3`,
      [orderId, ctx.environment, ctx.unitId, customerId],
    );
  }

  // O pedido do bot (entrega OU retirada) NÃO abre conta a receber no nascimento: o
  // cliente só paga quando o produto chega na mão dele (entrega) ou quando vem buscar
  // (retirada). Conta a receber é dívida (fiado), e aqui não há dívida — o dinheiro
  // entra no caixa só no "marcar entregue"/"marcar retirado" do painel (já como
  // recebível 'received'). Decisão Wallace 2026-06-08. Antes a entrega abria recebível
  // 'open' aqui, o que inflava o "a receber" com pedido que nem saiu.
  const o = await client.query<{ total_amount: string; customer_name: string | null }>(
    `SELECT total_amount, customer_name FROM commerce.partner_orders
     WHERE id = $1 AND environment = $2 AND unit_id = $3 LIMIT 1`,
    [orderId, ctx.environment, ctx.unitId],
  );
  const row = o.rows[0]!;

  logger.info({ environment: ctx.environment, unit_id: ctx.unitId, partner_order_id: orderId }, 'bot: partner_order materializado (2w)');
  return { partner_order_id: orderId, total_amount: row.total_amount };
}
