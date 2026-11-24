import { moneyCents } from '../shared/catalog-pricing.js';

export interface MarketQuoteProduct {
  product_id: string;
  price_amount: string | null;
  brand?: string | null;
  product_name?: string | null;
  tread_pattern?: string | null;
}

interface MarketQuoteGroup {
  product_id: string;
  preco_unitario: number;
  quantidade: number;
  modelo?: string | null;
}

const amount = String.raw`(?:\d{1,3}(?:\.\d{3})+(?:,\d{2})?|\d+(?:[,.]\d{2})?)(?!\d|[,.]\d)`;
const currency = new RegExp(String.raw`\br\$\s*(${amount})|(?<![\d./])(${amount})\s*reais?\b`, 'gi');
const unrelatedPrice = /\b(?:frete|taxa|montagem|instalacao|desconto|economia|servico|parcelas?|orcamento|internet|online|(?:prefere|pretende|pode|quer) gastar|nao (?:consigo|posso|sai|fica|vendo|faco))\b|\b\d{1,2}\s*x\s*(?:de\s+)?r\$/;

function priceCents(value: string): number {
  if (value.includes(',')) return moneyCents(Number(value.replace(/\./g, '').replace(',', '.')));
  return moneyCents(Number(/\.\d{3}(?:\.|$)/.test(value) ? value.replace(/\./g, '') : value));
}

function comparableText(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function containsIdentity(text: string, value?: string | null): boolean {
  const phrase = value ? comparableText(value).replace(/[^a-z0-9]+/g, ' ').trim() : '';
  return phrase.length >= 2 && text.includes(` ${phrase} `);
}

/** Confirma uma cotação de pneu no texto efetivamente enviado e sua identidade no resultado daquela busca. */
export function matchesSentMarketQuote(
  sentText: string, productId: string, products: readonly MarketQuoteProduct[], group?: MarketQuoteGroup,
): boolean {
  const priced = products.map(product => {
    const quotedGroup = group?.product_id === product.product_id ? group : undefined;
    const unit = moneyCents(Number(quotedGroup?.preco_unitario ?? product.price_amount));
    return { product, unit, total: quotedGroup ? unit * quotedGroup.quantidade : null,
      model: quotedGroup?.modelo ?? product.tread_pattern };
  });
  const quoted = new Set<string>();
  const plainText = comparableText(sentText).replace(/[*_~`]/g, '');
  for (const clause of plainText.split(/[\n;!?]+|[,.](?!\d)/)) {
    const offer = clause.replace(/\b(?:sem frete|frete (?:gratis|gratuito)|montagem (?:gratis|gratuita))\b/g, '');
    if (unrelatedPrice.test(offer)) continue;
    const amounts = [...offer.matchAll(currency)].map(match => priceCents(match[1] ?? match[2]!));
    if (!amounts.length) continue;
    const text = ` ${offer.replace(/[^a-z0-9]+/g, ' ').trim()} `;
    const perUnit = /\b(?:cada|por unidade|unitario)\b/.test(text);
    const wholeSet = /\b(?:conjunto|jogo|par|total)\b/.test(text);
    const namedBrands = priced.filter(row => containsIdentity(text, row.product.brand));
    const models = priced.filter(row => containsIdentity(text, row.model));
    const namedModels = models.length ? models : priced.filter(row => containsIdentity(text, row.product.product_name));
    for (const row of priced) {
      const prices = row.total === null || perUnit ? [row.unit] : wholeSet ? [row.total] : [row.unit, row.total];
      if (prices.some(price => price > 0 && amounts.includes(price))
        && (!namedBrands.length || namedBrands.includes(row)) && (!namedModels.length || namedModels.includes(row))) {
        quoted.add(row.product.product_id);
      }
    }
  }
  return quoted.size === 1 && quoted.has(productId);
}
