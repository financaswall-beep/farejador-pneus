/**
 * Matemática da comissão por pessoa (Bloco 2, migration 0100) — lógica PURA, sem banco.
 * Mora fora de queries.ts pra ser testável sem env/db (e pra ser a FONTE ÚNICA do
 * cálculo, usada pelo "Meu desempenho" no TS e espelhada pelo card da equipe no SQL).
 */

export interface PartnerCommissionConfig {
  kind: 'percent' | 'fixed';
  value: number;
  active: boolean;
}

/**
 * Comissão de UMA venda (round por linha). Fonte única usada nas duas telas pra
 * garantir que a soma das linhas == o total exibido (Wallace confere somando na mão).
 *
 * 💰 CONCILIAÇÃO COM O SQL: o card da equipe arredonda no Postgres
 * (round(total_amount * value/100.0, 2), NUMERIC exato, metade-pra-cima). Aqui o "Meu
 * desempenho" TEM de dar o MESMO centavo. Por isso a conta de % é feita em CENTAVOS
 * INTEIROS (sem fuzz de float), arredondando metade-pra-cima igual ao NUMERIC do banco.
 */
export function lineCommission(cfg: PartnerCommissionConfig, amount: number): number {
  if (!cfg.active) return 0;
  if (cfg.kind === 'fixed') return Math.round(cfg.value * 100) / 100;
  // percent: amountCents * value / 100, arredondado a centavo (metade-pra-cima = banco).
  const amountCents = Math.round(amount * 100);
  const cents = Math.round((amountCents * cfg.value) / 100);
  return cents / 100;
}
