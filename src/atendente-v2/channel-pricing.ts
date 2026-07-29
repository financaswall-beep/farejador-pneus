import type { PoolClient } from 'pg';
import type {
  CompatibilidadeResultado,
  ProdutoOferta,
} from '../atendente/tools/commerce-tools.js';
import {
  loadCurrentCatalogPrices,
  loadCurrentPartnerPrices,
  moneyCents,
} from '../shared/catalog-pricing.js';
import type { Environment } from '../shared/types/chatwoot.js';

type Availability = number | { available: number };
type AvailabilityMap = ReadonlyMap<string, Availability>;

export async function applyMatrizPricesToCompatibility(
  client: PoolClient,
  environment: Environment,
  result: CompatibilidadeResultado[],
): Promise<void> {
  const prices = await loadCurrentCatalogPrices(
    client,
    environment,
    result.flatMap((vehicle) => vehicle.produtos.map((product) => product.product_id)),
  );
  for (const vehicle of result) {
    for (const product of vehicle.produtos) {
      const price = prices.get(product.product_id);
      product.current_price = price ? price.price_amount.toFixed(2) : null;
    }
  }
}

export async function applyMatrizPricesToProducts(
  client: PoolClient,
  environment: Environment,
  result: ProdutoOferta[],
): Promise<void> {
  const prices = await loadCurrentCatalogPrices(
    client,
    environment,
    result.map((product) => product.product_id),
  );
  for (const product of result) {
    const price = prices.get(product.product_id);
    product.price_amount = price ? price.price_amount.toFixed(2) : null;
    product.currency = price?.currency ?? null;
    product.price_type = price?.price_type ?? null;
  }
}

export async function applyPartnerPricesToCompatibility(
  client: PoolClient,
  environment: Environment,
  result: CompatibilidadeResultado[],
  availability: AvailabilityMap,
): Promise<boolean> {
  const prices = await loadCurrentPartnerPrices(client, environment, [...availability.keys()]);
  let applied = false;
  for (const vehicle of result) {
    for (const product of vehicle.produtos) {
      const available = availabilityAmount(availability.get(product.product_id));
      const price = prices.get(product.product_id);
      if (available === null || !price) continue;
      product.total_stock = available;
      product.current_price = price.price_amount.toFixed(2);
      applied = true;
    }
  }
  return applied;
}

export async function applyPartnerPricesToProducts(
  client: PoolClient,
  environment: Environment,
  result: ProdutoOferta[],
  availability: AvailabilityMap,
): Promise<boolean> {
  const prices = await loadCurrentPartnerPrices(client, environment, [...availability.keys()]);
  let applied = false;
  for (const product of result) {
    const available = availabilityAmount(availability.get(product.product_id));
    const price = prices.get(product.product_id);
    if (available === null || !price) continue;
    product.total_stock_available = available;
    product.price_amount = price.price_amount.toFixed(2);
    product.currency = price.currency;
    product.price_type = price.price_type;
    applied = true;
  }
  return applied;
}

interface QuotedItem {
  product_id: string;
  quantidade: number;
  preco_unitario: number;
}

export async function repriceMatrizQuotedItems<T extends QuotedItem>(
  client: PoolClient,
  environment: Environment,
  quotedItems: T[],
): Promise<
  | { ok: true; items: T[] }
  | { ok: false; response: Record<string, unknown> }
> {
  const prices = await loadCurrentCatalogPrices(
    client,
    environment,
    quotedItems.map((item) => item.product_id),
  );
  const changed = quotedItems.flatMap((item) => {
    const official = prices.get(item.product_id);
    if (official && moneyCents(official.price_amount) === moneyCents(item.preco_unitario)) return [];
    return [{
      product_id: item.product_id,
      preco_informado: item.preco_unitario,
      preco_atual: official?.price_amount ?? null,
    }];
  });
  if (changed.length > 0) {
    return {
      ok: false,
      response: {
        erro: changed.some((item) => item.preco_atual === null)
          ? 'catalog_price_missing'
          : 'preco_alterado',
        preco_alterado: true,
        itens: changed,
        mensagem:
          'O preço oficial da Matriz mudou ou está ausente. Consulte o Catálogo novamente, informe o valor atual ao cliente e só feche depois da nova confirmação.',
      },
    };
  }
  return {
    ok: true,
    items: quotedItems.map((item) => ({
      ...item,
      preco_unitario: prices.get(item.product_id)!.price_amount,
    })),
  };
}

function availabilityAmount(value: Availability | undefined): number | null {
  if (typeof value === 'number') return value;
  return value?.available ?? null;
}
