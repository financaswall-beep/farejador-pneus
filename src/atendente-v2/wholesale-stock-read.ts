import type { PoolClient } from 'pg';

/**
 * Unificação atacado×varejo (Fase 1 — LEITURA). Quando o bot roteia pra MATRIZ, o estoque
 * vem do GALPÃO do atacado (commerce.wholesale_stock, por MEDIDA) em vez da semente
 * commerce.stock_levels. NÃO toca partner_stock_levels (estoque dos parceiros = intocado,
 * trava do dono). Atrás da flag WHOLESALE_UNIFIED_STOCK (passada por quem chama, pra ser
 * testável sem env). Módulo puro: só recebe o client + a flag.
 */

/**
 * Chave canônica de uma medida de pneu: os 3 primeiros números (largura/perfil/aro),
 * ignorando separadores e letras. Faz '90/90-18' == '90/90R18' == ' 90/90 - 18 ' ==
 * '90/90-18 62P', e cobre polegada ('3.00-10' → '3-00-10') e radial ('150/60ZR17' →
 * '150-60-17'). Vazio ('') quando não há números → não casa NADA (seguro). PURA.
 */
export function tireSizeKey(measure: string | null | undefined): string {
  const nums = (measure ?? '').match(/\d+/g);
  if (!nums || nums.length === 0) return '';
  return nums.slice(0, 3).join('-');
}

/**
 * Estoque do GALPÃO do atacado para o produto pedido — a "ponte" produto→medida→galpão.
 * 1) acha a MEDIDA do produto (commerce.tire_specs.tire_size);
 * 2) soma as linhas do galpão (commerce.wholesale_stock) cuja medida bate por tireSizeKey
 *    (robusto a '90/90R18' vs '90/90-18'). O galpão é pequeno (dezenas de medidas) → casar
 *    em código mantém a regra testável e sem depender do formato cru da string.
 * Retorna a quantidade disponível (≥ 0). Não considera reserva (a matriz não reserva hoje).
 */
export async function getMatrizWholesaleStockQty(
  client: PoolClient,
  environment: 'prod' | 'test',
  productId: string,
): Promise<number> {
  const spec = await client.query<{ tire_size: string | null }>(
    `SELECT tire_size FROM commerce.tire_specs WHERE product_id = $1 AND environment = $2 LIMIT 1`,
    [productId, environment],
  );
  const key = tireSizeKey(spec.rows[0]?.tire_size);
  if (!key) return 0; // produto sem medida casável → não inventa estoque (nem consulta o galpão)

  const stock = await client.query<{ measure: string; quantity_on_hand: number | string }>(
    `SELECT measure, quantity_on_hand FROM commerce.wholesale_stock WHERE environment = $1`,
    [environment],
  );
  let total = 0;
  for (const row of stock.rows) {
    if (tireSizeKey(row.measure) === key) total += Number(row.quantity_on_hand) || 0;
  }
  return total;
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

  const specs = await client.query<{ product_id: string; tire_size: string | null }>(
    `SELECT product_id, tire_size FROM commerce.tire_specs WHERE environment = $1 AND product_id = ANY($2)`,
    [environment, productIds],
  );
  const stock = await client.query<{ measure: string; quantity_on_hand: number | string }>(
    `SELECT measure, quantity_on_hand FROM commerce.wholesale_stock WHERE environment = $1`,
    [environment],
  );
  // soma o galpão por chave canônica de medida (uma vez), depois aponta cada produto
  const byKey = new Map<string, number>();
  for (const row of stock.rows) {
    const k = tireSizeKey(row.measure);
    if (k) byKey.set(k, (byKey.get(k) ?? 0) + (Number(row.quantity_on_hand) || 0));
  }
  for (const s of specs.rows) {
    const k = tireSizeKey(s.tire_size);
    out.set(s.product_id, k ? byKey.get(k) ?? 0 : 0);
  }
  return out;
}

export interface GalpaoShortfall {
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
  const specs = await client.query<{ product_id: string; tire_size: string | null }>(
    `SELECT product_id, tire_size FROM commerce.tire_specs WHERE environment = $1 AND product_id = ANY($2)`,
    [environment, [...qtyByProduct.keys()]],
  );
  const tireSizeByProduct = new Map<string, string | null>();
  for (const s of specs.rows) tireSizeByProduct.set(s.product_id, s.tire_size);

  const requestedByKey = new Map<string, number>();
  const labelByKey = new Map<string, string>();
  const shortfalls: GalpaoShortfall[] = [];
  for (const [productId, qty] of qtyByProduct) {
    const tireSize = tireSizeByProduct.get(productId) ?? null;
    const key = tireSizeKey(tireSize);
    if (!key) {
      // produto sem medida casável (ou sem spec) → não casa NADA no galpão → falta tudo
      shortfalls.push({ measure: tireSize ?? 'medida não identificada', available: 0, requested: qty });
      continue;
    }
    requestedByKey.set(key, (requestedByKey.get(key) ?? 0) + qty);
    if (!labelByKey.has(key)) labelByKey.set(key, tireSize ?? key);
  }

  if (requestedByKey.size === 0) return shortfalls;

  // 3. soma o disponível no galpão por chave — COM FOR UPDATE (trava a corrida até o commit)
  const stock = await client.query<{ measure: string; quantity_on_hand: number | string }>(
    `SELECT measure, quantity_on_hand FROM commerce.wholesale_stock WHERE environment = $1 FOR UPDATE`,
    [environment],
  );
  const availByKey = new Map<string, number>();
  for (const row of stock.rows) {
    const k = tireSizeKey(row.measure);
    if (k) availByKey.set(k, (availByKey.get(k) ?? 0) + (Number(row.quantity_on_hand) || 0));
  }

  // 4. compara pedido × disponível por chave → falta quando disponível < pedido
  for (const [key, requested] of requestedByKey) {
    const available = availByKey.get(key) ?? 0;
    if (available < requested) {
      shortfalls.push({ measure: labelByKey.get(key) ?? key, available, requested });
    }
  }
  return shortfalls;
}

/**
 * Baixa no GALPÃO da matriz (commerce.wholesale_stock) quando a MATRIZ vende no VAREJO —
 * balcão ou bot. É a "outra metade" da unificação: a leitura já existia, esta é a ESCRITA.
 * Recebe os itens por PRODUTO (product_id), resolve a medida (tire_specs) e abate por
 * tireSizeKey (a MESMA régua da leitura — robusta a formato), com CLAMP em 0 (a venda
 * NUNCA trava por estoque; medida sem linha no galpão simplesmente não baixa).
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
  const specs = await client.query<{ product_id: string; tire_size: string | null }>(
    `SELECT product_id, tire_size FROM commerce.tire_specs WHERE environment = $1 AND product_id = ANY($2)`,
    [environment, [...qtyByProduct.keys()]],
  );
  const qtyByKey = new Map<string, number>();
  for (const s of specs.rows) {
    const key = tireSizeKey(s.tire_size);
    if (key) qtyByKey.set(key, (qtyByKey.get(key) ?? 0) + (qtyByProduct.get(s.product_id) ?? 0));
  }
  if (qtyByKey.size === 0) return;

  // 3. abate a linha do galpão que casa por chave (uma por chave; clamp em 0). Captura o
  //    delta REAL (antes − depois): sob clamp, "pedi 5 mas só tinha 3" registra 3 removidos,
  //    não 5 — a devolução no cancelamento nunca infla o estoque (fura o clamp assimétrico).
  const stock = await client.query<{ measure: string }>(
    `SELECT measure FROM commerce.wholesale_stock WHERE environment = $1`,
    [environment],
  );
  const done = new Set<string>();
  const movements: Array<{ measure: string; qty: number }> = [];
  for (const row of stock.rows) {
    const key = tireSizeKey(row.measure);
    if (!key || done.has(key)) continue;
    const qty = qtyByKey.get(key);
    if (!qty) continue;
    const upd = await client.query<{ old_qty: string; new_qty: string }>(
      `WITH antes AS (
         SELECT quantity_on_hand AS q FROM commerce.wholesale_stock
          WHERE environment = $1 AND measure = $2 FOR UPDATE
       )
       UPDATE commerce.wholesale_stock s
          SET quantity_on_hand = GREATEST(0, s.quantity_on_hand - $3)
         FROM antes
        WHERE s.environment = $1 AND s.measure = $2
        RETURNING antes.q AS old_qty, s.quantity_on_hand AS new_qty`,
      [environment, row.measure, qty],
    );
    done.add(key);
    const removed = Number(upd.rows[0]?.old_qty ?? 0) - Number(upd.rows[0]?.new_qty ?? 0);
    if (removed > 0) movements.push({ measure: row.measure, qty: removed });
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
 *   - venda sob clamp (tirou menos que o pedido) → devolve só o que saiu;
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
  const dec = await client.query<{ payload_after: { movements?: Array<{ measure: string; qty: number }> } }>(
    `SELECT payload_after FROM audit.events
      WHERE environment = $1 AND entity_id = $2 AND event_type = 'matriz_galpao_decrement'
      ORDER BY created_at DESC LIMIT 1`,
    [environment, orderId],
  );
  const movements = dec.rows[0]?.payload_after?.movements ?? [];
  if (movements.length === 0) return; // não baixou → nada a devolver

  for (const mv of movements) {
    if (!mv.measure || !(mv.qty > 0)) continue;
    await client.query(
      `UPDATE commerce.wholesale_stock
          SET quantity_on_hand = quantity_on_hand + $3
        WHERE environment = $1 AND measure = $2`,
      [environment, mv.measure, mv.qty],
    );
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
 * casam a mesma chave vale a de MAIOR quantity_on_hand COM custo preenchido
 * (determinístico; na prática o galpão tem uma linha por medida desde a 0113).
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

  const specs = await client.query<{ product_id: string; tire_size: string | null }>(
    `SELECT product_id, tire_size FROM commerce.tire_specs WHERE environment = $1 AND product_id = ANY($2)`,
    [environment, productIds],
  );
  const stock = await client.query<{ measure: string; quantity_on_hand: number | string; unit_cost: string | null }>(
    `SELECT measure, quantity_on_hand, unit_cost FROM commerce.wholesale_stock WHERE environment = $1`,
    [environment],
  );

  const bestByKey = new Map<string, { qty: number; cost: number }>();
  for (const row of stock.rows) {
    const key = tireSizeKey(row.measure);
    if (!key || row.unit_cost === null || row.unit_cost === undefined) continue;
    const qty = Number(row.quantity_on_hand) || 0;
    const cur = bestByKey.get(key);
    if (!cur || qty > cur.qty) bestByKey.set(key, { qty, cost: Number(row.unit_cost) });
  }
  for (const s of specs.rows) {
    const key = tireSizeKey(s.tire_size);
    const best = key ? bestByKey.get(key) : undefined;
    if (best) out.set(s.product_id, best.cost);
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
