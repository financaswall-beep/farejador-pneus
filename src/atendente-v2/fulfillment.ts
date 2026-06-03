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
  };
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
const PARTNER_COVERAGE: Record<string, string[]> = {
  'borracharia-rio-do-ouro': ['itaborai'],
};

/** Frete fixo da rede (decisão Wallace 2026-06-02): R$ 9,90 pra todos. */
export const FRETE_PADRAO_BRL = 9.9;

function normalizeRegion(s: string | null | undefined): string {
  return (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

function partnerCoversRegion(partner: PartnerContext, municipio: string | null | undefined): boolean {
  const areas = PARTNER_COVERAGE[partner.slug];
  if (!areas || areas.length === 0) return false;
  const m = normalizeRegion(municipio);
  if (!m) return false;
  return areas.some((a) => {
    const an = normalizeRegion(a);
    return an === m || m.includes(an);
  });
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
  const partner = await resolveUnitForOrder(client, environment);

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

  // 1. Região do parceiro?
  if (partner && partnerCoversRegion(partner, input.municipio)) {
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
       $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13
     ) AS id`,
    [
      ctx.environment,
      ctx.unitId,
      input.customer_name,
      input.customer_phone,
      JSON.stringify(input.items),
      'A receber', // COD — pago na entrega
      input.fulfillment_mode,
      input.delivery_address,
      `bot:${ctx.slug}`,
      input.idempotency_key,
      '2w', // source_tag — venda trazida pelo bot
      0, // discount
      input.freight_amount,
    ],
  );
  const orderId = reg.rows[0]!.id;

  if (customerId) {
    await client.query(
      `UPDATE commerce.partner_orders SET customer_id = $4, updated_at = now()
       WHERE id = $1 AND environment = $2 AND unit_id = $3`,
      [orderId, ctx.environment, ctx.unitId, customerId],
    );
  }

  // COD: conta a receber aberta (só pra delivery; pickup paga na hora seria 'received',
  // mas no fluxo do bot a entrega é o padrão e o pagamento é sempre na entrega).
  const o = await client.query<{ total_amount: string; customer_name: string | null }>(
    `SELECT total_amount, customer_name FROM commerce.partner_orders
     WHERE id = $1 AND environment = $2 AND unit_id = $3 LIMIT 1`,
    [orderId, ctx.environment, ctx.unitId],
  );
  const row = o.rows[0]!;
  await client.query(
    `INSERT INTO finance.partner_receivables (
       environment, unit_id, customer_id, customer_name, description, source_tag, amount,
       due_date, status, received_at, payment_method, notes, created_by, idempotency_key, source_order_id
     ) VALUES ($1, $2, $3, $4, $5, '2w', $6, NULL, 'open', NULL, NULL, $7, $8, $9, $10)
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
     DO NOTHING`,
    [
      ctx.environment,
      ctx.unitId,
      customerId,
      input.customer_name ?? row.customer_name ?? null,
      `Venda a receber ${orderId.slice(0, 8)}`,
      row.total_amount,
      `Gerada pelo bot (2w) — pedido ${orderId.slice(0, 8)}`,
      `bot:${ctx.slug}`,
      `order:${orderId}:receivable`,
      orderId,
    ],
  );

  logger.info({ environment: ctx.environment, unit_id: ctx.unitId, partner_order_id: orderId }, 'bot: partner_order materializado (2w)');
  return { partner_order_id: orderId, total_amount: row.total_amount };
}
