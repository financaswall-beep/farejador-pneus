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
