import { env } from '../shared/config/env.js';

/**
 * Janela de validade da LOCALIZAÇÃO do cliente (o pino), em horas — config
 * `LOCATION_FRESHNESS_HOURS`. `null` = sem janela (o pino da conversa vale pra
 * sempre; comportamento até 2026-07-16). `N > 0` = o pino só conta se veio nas
 * últimas N horas; mais velho, o chamador trata como "sem pino" e o bot pede a
 * localização de novo (decisão Wallace 2026-07-16 — o cliente pode ter se mudado).
 *
 * Isolado NESTE módulo de propósito: `customer-location.ts` NÃO importa `env`
 * (fica puro/testável a seco); só o default de parâmetro puxa a config em produção.
 */
export function locationFreshnessHours(): number | null {
  const h = env.LOCATION_FRESHNESS_HOURS;
  return Number.isFinite(h) && h > 0 ? h : null;
}
