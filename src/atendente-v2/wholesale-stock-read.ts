import type { PoolClient } from 'pg';
import { tireSizeKey } from '../shared/tire-size.js';
import { buildMatrizStockIndex, matrizStockForMeasure } from '../shared/matriz-stock-source.js';
import {
  loadMatrizOfficialStock, loadMatrizProductStockSpecs, stockBrandKey,
} from './matriz-stock-variants.js';
export { tireSizeKey } from '../shared/tire-size.js';
import type { TireCondition } from '../shared/tire-condition.js';

/**
 * Unificação atacado×varejo (Fase 1 — LEITURA). Quando o bot roteia pra MATRIZ, o estoque
 * vem do GALPÃO do atacado (commerce.wholesale_stock, por MEDIDA) em vez da semente
 * commerce.stock_levels. NÃO toca partner_stock_levels (estoque dos parceiros = intocado,
 * trava do dono). Atrás da flag WHOLESALE_UNIFIED_STOCK (passada por quem chama, pra ser
 * testável sem env). Módulo puro: só recebe o client + a flag.
 */

export async function getMatrizWholesaleStockQty(
  client: PoolClient,
  environment: 'prod' | 'test',
  productId: string,
): Promise<number> {
  const spec = (await loadMatrizProductStockSpecs(client, environment, [productId]))[0];
  const key = tireSizeKey(spec?.tire_size);
  if (!key) return 0; // produto sem medida casável → não inventa estoque (nem consulta o galpão)

  const stock = await loadMatrizOfficialStock(client, environment);
  const state = matrizStockForMeasure(
    buildMatrizStockIndex(stock), key, spec?.brand, spec?.tire_condition,
  );
  return state.sellable ? state.quantity_on_hand : 0;
}

/**
 * Versão em LOTE de getMatrizWholesaleStockQty — pra a BUSCA, que mostra vários produtos.
 * Só 2 consultas pro grupo todo (os tire_size dos produtos + o galpão inteiro), casando por
 * tireSizeKey em memória. Retorna Map product_id → quantidade no galpão (0 quando não tem).
 * NÃO toca partner_stock_levels. Usado quando a busca cai na MATRIZ e a flag liga.
 */
export async function getMatrizWholesaleStockMap(
  client: PoolClient,
  environment: 'prod' | 'test',
  productIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (productIds.length === 0) return out;

  const specs = await loadMatrizProductStockSpecs(client, environment, productIds);
  const stockIndex = buildMatrizStockIndex(await loadMatrizOfficialStock(client, environment));
  for (const s of specs) {
    const state = matrizStockForMeasure(
      stockIndex, s.tire_size, s.brand, s.tire_condition,
    );
    out.set(s.product_id, state.sellable ? state.quantity_on_hand : 0);
  }
  return out;
}

export interface GalpaoShortfall {
  brand: string | null;
  tire_condition: TireCondition;
  measure: string; // rótulo da medida pedida (o que o cliente quer), pra mensagem ao cliente
  available: number; // soma disponível no galpão pra aquela medida (por chave canônica)
  requested: number; // quanto o pedido pediu pra aquela medida
}

/**
 * Trava de OVERSELL da matriz no VAREJO (bot/balcão) — a "guarda" que faltava pra a matriz
 * NUNCA prometer/vender além do galpão (Camada 1b). Espelha a trava do ATACADO
 * (registerWholesaleSale), mas pro caminho do varejo. LÊ o galpão com FOR UPDATE (trava as
 * linhas até o commit da transação de QUEM CHAMA → sem corrida entre 2 vendas do mesmo pneu)
 * e devolve as FALTAS (medida, disponível, pedido). Lista vazia = pode vender.
 *
 * Mesma régua da leitura/baixa: produto→medida (tire_specs)→chave canônica (tireSizeKey);
 * soma o galpão por chave. Produto sem medida casável, sem spec, ou medida sem linha no
 * galpão → disponível 0 (não inventa estoque → vira falta). PURA (recebe client + itens);
 * DEVE rodar DENTRO da transação da venda (o FOR UPDATE só segura enquanto a transação vive).
 */
export async function checkMatrizGalpaoShortfall(
  client: PoolClient,
  environment: 'prod' | 'test',
  items: Array<{ productId: string; quantity: number }>,
): Promise<GalpaoShortfall[]> {
  // 1. agrega a quantidade pedida por produto
  const qtyByProduct = new Map<string, number>();
  for (const it of items) {
    if (it.quantity > 0) qtyByProduct.set(it.productId, (qtyByProduct.get(it.productId) ?? 0) + it.quantity);
  }
  if (qtyByProduct.size === 0) return [];

  // 2. produto → medida (tire_size); agrega a quantidade pedida por CHAVE canônica e guarda
  //    um rótulo (a medida crua do produto) pra a mensagem ao cliente.
  const specs = await loadMatrizProductStockSpecs(client, environment, [...qtyByProduct.keys()]);
  const tireSizeByProduct = new Map<string, string | null>();
  const brandByProduct = new Map<string, string | null>();
  const conditionByProduct = new Map<string, TireCondition>();
  for (const s of specs) {
    tireSizeByProduct.set(s.product_id, s.tire_size);
    brandByProduct.set(s.product_id, s.brand);
    conditionByProduct.set(s.product_id, s.tire_condition);
  }

  const requestedByKey = new Map<string, number>();
  const labelByKey = new Map<string, string>();
  const brandByKey = new Map<string, string | null>();
  const conditionByKey = new Map<string, TireCondition>();
  const shortfalls: GalpaoShortfall[] = [];
  for (const [productId, qty] of qtyByProduct) {
    const tireSize = tireSizeByProduct.get(productId) ?? null;
    const brand = brandByProduct.get(productId) ?? null;
    const tireCondition = conditionByProduct.get(productId) ?? 'meia_vida';
    const key = tireSizeKey(tireSize);
    if (!key) {
      // produto sem medida casável (ou sem spec) → não casa NADA no galpão → falta tudo
      shortfalls.push({
        measure: tireSize ?? 'medida não identificada', brand,
        tire_condition: tireCondition, available: 0, requested: qty,
      });
      continue;
    }
    const variantKey = `${key}\u0000${stockBrandKey(brand)}\u0000${tireCondition}`;
    requestedByKey.set(variantKey, (requestedByKey.get(variantKey) ?? 0) + qty);
    if (!labelByKey.has(variantKey)) labelByKey.set(variantKey, tireSize ?? key);
    brandByKey.set(variantKey, brand);
    conditionByKey.set(variantKey, tireCondition);
  }

  if (requestedByKey.size === 0) return shortfalls;

  // 3. soma o disponível no galpão por chave — COM FOR UPDATE (trava a corrida até o commit)
  const stockIndex = buildMatrizStockIndex(
    await loadMatrizOfficialStock(client, environment, true),
  );

  // 4. compara pedido × disponível por chave → falta quando disponível < pedido
  for (const [variantKey, requested] of requestedByKey) {
    const key = variantKey.split('\u0000')[0]!;
    const brand = brandByKey.get(variantKey) ?? null;
    const tireCondition = conditionByKey.get(variantKey) ?? 'meia_vida';
    const state = matrizStockForMeasure(stockIndex, key, brand, tireCondition);
    const available = state.sellable ? state.quantity_on_hand : 0;
    if (available < requested) {
      shortfalls.push({
        measure: labelByKey.get(variantKey) ?? key, brand,
        tire_condition: tireCondition, available, requested,
      });
    }
  }
  return shortfalls;
}

/**
 * Baixa no GALPÃO da matriz (commerce.wholesale_stock) quando a MATRIZ vende no VAREJO —
 * balcão ou bot. É a "outra metade" da unificação: a leitura já existia, esta é a ESCRITA.
 * Recebe os itens por PRODUTO (product_id), resolve a medida (tire_specs) e abate por
 * tireSizeKey (a MESMA régua da leitura — robusta a formato). Falha fechada quando
 * falta medida, saldo ou custo, ou quando a medida oficial está duplicada.
 *
 * ⚠️ SÓ a MATRIZ chama isto — o estoque dos PARCEIROS (partner_stock_levels) JAMAIS é
 * tocado aqui (trava do dono). `enabled` = flag (passada por quem chama, testável sem env).
 * Deve rodar DENTRO da transação da venda pra ser atômica (rollback desfaz venda + baixa).
 */
export async function applyMatrizGalpaoDecrement(
  client: PoolClient,
  environment: 'prod' | 'test',
  items: Array<{ productId: string; quantity: number }>,
  enabled: boolean,
  orderId?: string,
): Promise<void> {
  if (!enabled || items.length === 0) return;

  // 1. agrega a quantidade por produto
  const qtyByProduct = new Map<string, number>();
  for (const it of items) {
    if (it.quantity > 0) qtyByProduct.set(it.productId, (qtyByProduct.get(it.productId) ?? 0) + it.quantity);
  }
  if (qtyByProduct.size === 0) return;

  // 2. produto → medida (tire_size) → chave canônica; soma a quantidade por chave
  const specs = await loadMatrizProductStockSpecs(client, environment, [...qtyByProduct.keys()]);
  const sizeByProduct = new Map(specs.map((row) => [row.product_id, row.tire_size]));
  const brandByProduct = new Map(specs.map((row) => [row.product_id, row.brand]));
  const conditionByProduct = new Map(
    specs.map((row) => [row.product_id, row.tire_condition]),
  );
  const qtyByKey = new Map<string, {
    key: string; brand: string | null; tire_condition: TireCondition; quantity: number;
  }>();
  for (const [productId, quantity] of qtyByProduct) {
    const key = tireSizeKey(sizeByProduct.get(productId));
    if (!key) throw new Error('walkin_measure_not_found');
    const brand = brandByProduct.get(productId) ?? null;
    const tireCondition = conditionByProduct.get(productId) ?? 'meia_vida';
    const variantKey = `${key}\u0000${stockBrandKey(brand)}\u0000${tireCondition}`;
    const current = qtyByKey.get(variantKey) ?? {
      key, brand, tire_condition: tireCondition, quantity: 0,
    };
    current.quantity += quantity;
    qtyByKey.set(variantKey, current);
  }

  // 3. trava e valida a mesma linha oficial usada pelas demais leituras.
  const stockIndex = buildMatrizStockIndex(
    await loadMatrizOfficialStock(client, environment, true),
  );
  const plan: Array<{
    measure: string; brand: string; tire_condition: TireCondition; qty: number;
  }> = [];
  for (const { key, brand, tire_condition: condition, quantity: qty } of qtyByKey.values()) {
    const state = matrizStockForMeasure(stockIndex, key, brand, condition);
    if (state.block_reason) throw new Error(state.block_reason);
    if (state.quantity_on_hand < qty) throw new Error('walkin_stock_insufficient');
    plan.push({
      measure: state.measure!, brand: state.brand!, tire_condition: condition, qty,
    });
  }

  // rótulo pro filme do galpão (0128): o trigger grava a baixa com origem 'varejo'
  await client.query(
    `SELECT set_config('app.galpao_source','varejo',true), set_config('app.galpao_ref',COALESCE($1,''),true)`,
    [orderId ?? null],
  );

  const movements: Array<{
    measure: string; brand: string; tire_condition: TireCondition; qty: number;
  }> = [];
  for (const line of plan) {
    const updated = await client.query(
      `UPDATE commerce.wholesale_stock
          SET quantity_on_hand = quantity_on_hand - $5
        WHERE environment = $1 AND measure = $2 AND brand = $3
          AND tire_condition=$4 AND quantity_on_hand >= $5
        RETURNING quantity_on_hand`,
      [environment, line.measure, line.brand, line.tire_condition, line.qty],
    );
    if (updated.rowCount !== 1) throw new Error('walkin_stock_insufficient');
    movements.push(line);
  }

  // 4. trilha da baixa (audit.events) pra o cancelamento devolver EXATAMENTE o que saiu.
  //    Só grava se veio um orderId e algo saiu de fato — venda que não baixou não deixa
  //    rastro, então cancelá-la não devolve nada (sem estoque inventado).
  if (orderId && movements.length > 0) {
    await client.query(
      `INSERT INTO audit.events (environment, domain, entity_table, entity_id, event_type, actor_label, payload_after)
       VALUES ($1, 'stock', 'commerce.wholesale_stock', $2, 'matriz_galpao_decrement', 'matriz-venda', $3::jsonb)`,
      [environment, orderId, JSON.stringify({ order_id: orderId, movements })],
    );
  }
}

/**
 * Devolve ao GALPÃO o que a venda de VAREJO da matriz baixou, quando o pedido é CANCELADO —
 * o espelho do applyMatrizGalpaoDecrement. É guiada pela TRILHA (audit.events
 * 'matriz_galpao_decrement'), não pelos itens do pedido nem pela flag atual: devolve
 * EXATAMENTE o que a baixa registrou ter tirado. Consequências (todas desejadas):
 *   - venda que não baixou (flag off na hora) → sem trilha → devolve nada (não inventa);
 *   - venda antiga sob clamp → devolve só o que a trilha diz que saiu;
 *   - segundo cancelamento → grava 'matriz_galpao_return', o guard abaixo corta (idempotente).
 * Deve rodar na MESMA transação do cancelamento (rollback desfaz cancelamento + devolução).
 */
export async function applyMatrizGalpaoReturn(
  client: PoolClient,
  environment: 'prod' | 'test',
  orderId: string,
): Promise<void> {
  // idempotência: já devolvido? não devolve de novo.
  const already = await client.query(
    `SELECT 1 FROM audit.events
      WHERE environment = $1 AND entity_id = $2 AND event_type = 'matriz_galpao_return' LIMIT 1`,
    [environment, orderId],
  );
  if (already.rows.length > 0) return;

  // o que a venda REALMENTE tirou (última baixa registrada deste pedido).
  const dec = await client.query<{
    payload_after: { movements?: Array<{ measure: string; brand?: string;
      tire_condition?: TireCondition; qty: number }> };
  }>(
    `SELECT payload_after FROM audit.events
      WHERE environment = $1 AND entity_id = $2 AND event_type = 'matriz_galpao_decrement'
      ORDER BY created_at DESC LIMIT 1`,
    [environment, orderId],
  );
  const movements = dec.rows[0]?.payload_after?.movements ?? [];
  if (movements.length === 0) return; // não baixou → nada a devolver

  // rótulo pro filme do galpão (0128): devolução do cancelamento do varejo
  await client.query(
    `SELECT set_config('app.galpao_source','cancelamento_varejo',true), set_config('app.galpao_ref',$1,true)`,
    [orderId],
  );

  for (const mv of movements) {
    if (!mv.measure || !(mv.qty > 0)) continue;
    let brand = mv.brand ?? null;
    let tireCondition = mv.tire_condition ?? null;
    if (!brand || !tireCondition) {
      const filmed = await client.query<{ brand: string; tire_condition: TireCondition }>(
        `SELECT brand,tire_condition
           FROM commerce.wholesale_stock_movements
          WHERE environment=$1 AND measure=$2 AND source='varejo'
            AND ref=$3 AND qty_delta<0
          GROUP BY brand,tire_condition
          HAVING count(*) > 0
          LIMIT 2`,
        [environment, mv.measure, orderId],
      );
      if (filmed.rows.length !== 1) {
        throw new Error(`stock_variant_history_missing:${mv.measure}`);
      }
      brand = filmed.rows[0]!.brand;
      tireCondition = filmed.rows[0]!.tire_condition;
    }
    const updated = await client.query(
      `UPDATE commerce.wholesale_stock
          SET quantity_on_hand = quantity_on_hand + $5
        WHERE environment = $1 AND measure = $2 AND brand = $3
          AND tire_condition=$4
        RETURNING quantity_on_hand`,
      [environment, mv.measure, brand, tireCondition, mv.qty],
    );
    if (updated.rowCount !== 1) throw new Error(`stock_measure_missing:${mv.measure}`);
  }

  await client.query(
    `INSERT INTO audit.events (environment, domain, entity_table, entity_id, event_type, actor_label, payload_after)
     VALUES ($1, 'stock', 'commerce.wholesale_stock', $2, 'matriz_galpao_return', 'matriz-cancel', $3::jsonb)`,
    [environment, orderId, JSON.stringify({ order_id: orderId, movements })],
  );
}

/**
 * Custo médio do GALPÃO por produto (0117) — a MESMA ponte produto→medida→galpão da
 * leitura/baixa (tire_specs → tireSizeKey → wholesale_stock), devolvendo o unit_cost
 * (custo MÉDIO ponderado, mantido pelas entradas) em vez da quantidade. Entre linhas que
 * uma chave canônica duplicada fica fora do mapa, sem escolher custo arbitrário.
 * Produto sem medida casável, sem spec, ou medida sem custo → fica FORA do mapa
 * (não inventa custo — o chamador trata ausência como "sem custo congelado").
 */
export async function getMatrizGalpaoCostByProduct(
  client: PoolClient,
  environment: 'prod' | 'test',
  productIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (productIds.length === 0) return out;

  const specs = await loadMatrizProductStockSpecs(client, environment, productIds);
  const stockIndex = buildMatrizStockIndex(await loadMatrizOfficialStock(client, environment));
  for (const s of specs) {
    const state = matrizStockForMeasure(
      stockIndex, s.tire_size, s.brand, s.tire_condition,
    );
    const cost = state.sellable ? Number(state.unit_cost) : Number.NaN;
    if (Number.isFinite(cost) && cost > 0) out.set(s.product_id, cost);
  }
  return out;
}

/**
 * CONGELA o custo do galpão nos itens de uma venda do VAREJO da MATRIZ (0117) — o espelho,
 * no varejo, do snapshot que o ATACADO já faz (unit_cost em wholesale_order_items): o custo
 * médio pode mudar amanhã, mas o lucro DESTA venda fica gravado pra sempre. Escreve
 * commerce.order_items.matriz_unit_cost SÓ onde está NULL (retry/idempotência não
 * sobrescreve) e SÓ pros produtos com custo conhecido — item sem custo fica NULL e o
 * resumo conta como "sem custo" (honestidade > chute). ⚠️ SÓ a MATRIZ chama isto (quem
 * chama decide; parceiro JAMAIS passa aqui). `enabled` = flag por parâmetro (testável).
 */
export async function applyMatrizRetailCostSnapshot(
  client: PoolClient,
  environment: 'prod' | 'test',
  orderId: string,
  items: Array<{ productId: string; quantity: number }>,
  enabled: boolean,
): Promise<void> {
  if (!enabled || items.length === 0) return;
  const productIds = [...new Set(items.filter((i) => i.quantity > 0).map((i) => i.productId))];
  const costByProduct = await getMatrizGalpaoCostByProduct(client, environment, productIds);
  for (const [productId, cost] of costByProduct) {
    await client.query(
      `UPDATE commerce.order_items
          SET matriz_unit_cost = $4
        WHERE environment = $1 AND order_id = $2 AND product_id = $3 AND matriz_unit_cost IS NULL`,
      [environment, orderId, productId, cost],
    );
  }
}
