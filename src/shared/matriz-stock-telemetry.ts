import { logger } from './logger.js';
import type { Environment } from './types/chatwoot.js';

const reported = new Set<string>();

/** Avisa uma vez por processo quando a transicao volta a ler o estoque legado. */
export function recordMatrizLegacyStockRead(path: string, environment: Environment): void {
  const key = `${environment}:${path}`;
  if (reported.has(key)) return;
  reported.add(key);
  logger.warn({
    environment,
    path,
    stock_source: 'commerce.stock_levels',
    official_stock_source: 'commerce.wholesale_stock',
  }, 'matriz stock: fallback legado em uso');
}
