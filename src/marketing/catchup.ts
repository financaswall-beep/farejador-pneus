import type { Pool } from 'pg';

type Queryable = Pick<Pool, 'query'>;

/**
 * Recupera automaticamente a lacuna desde o último dia Meta concluído.
 * Mantém a janela normal de 60 dias e limita a retomada a 365 para não criar
 * uma chamada sem limite depois de uma instalação antiga ou banco vazio.
 */
export async function resolveMetaCatchupLookback(
  db: Queryable,
  environment: string,
  businessToday: string,
): Promise<number> {
  const result = await db.query<{ lookback_days: number | string }>(
    `SELECT CASE WHEN max(window_until) IS NULL THEN 60
            ELSE LEAST(365,GREATEST(60,$2::date-max(window_until)+1))
            END::int AS lookback_days
       FROM marketing.meta_sync_runs
      WHERE environment=$1 AND source='meta' AND status='succeeded'`,
    [environment, businessToday],
  );
  const value = Number(result.rows[0]?.lookback_days ?? 60);
  return Number.isInteger(value) && value >= 60 && value <= 365 ? value : 60;
}
