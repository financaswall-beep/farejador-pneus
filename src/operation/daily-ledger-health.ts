import type { Pool } from 'pg';
import { pool } from '../persistence/db.js';
import { env } from '../shared/config/env.js';
import { logger } from '../shared/logger.js';
import { businessDateSaoPaulo } from '../shared/business-time.js';
import { getMatrizLedgerIntegrationHealth } from '../admin/painel/matriz-ledger-integration-health.js';

type Reader = typeof getMatrizLedgerIntegrationHealth;
export type DailyLedgerHealth = {
  status: 'green' | 'yellow' | 'red' | 'disabled' | 'error';
  checked_at: string; error_signals: number; pending_signals: number;
};

/** One snapshot per business day, across replicas. Never invokes a backfill. */
export async function checkDailyLedgerHealth(
  environment: 'prod' | 'test' = env.FAREJADOR_ENV, db: Pool = pool,
  now = new Date(), read: Reader = getMatrizLedgerIntegrationHealth,
): Promise<boolean> {
  if (!env.MATRIZ_CENTRAL_LEDGER) return false;
  const client = await db.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const lock = await client.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) acquired`,
      [`daily-ledger-health:${environment}`]);
    if (!lock.rows[0]?.acquired) { await client.query('ROLLBACK'); return false; }
    const day = businessDateSaoPaulo(now);
    const previous = await client.query(`SELECT 1 FROM ops.matriz_ledger_health_checks
      WHERE environment=$1 AND checked_on=$2::date
        AND (status<>'error' OR checked_at>$3::timestamptz-interval '1 hour')`,
    [environment, day, now.toISOString()]);
    if (previous.rowCount) { await client.query('COMMIT'); return false; }
    // A reader failure must not erase yesterday's signal or block sales.
    await client.query('SAVEPOINT health_read');
    let status: DailyLedgerHealth['status'] = 'error', errors = 0, pending = 0;
    try {
      const health = await read(environment, client as unknown as Pool);
      status = health.status;
      errors = health.global.total_error_signals;
      pending = Object.values(health.modules).reduce((sum, module) => sum + module.pending, 0);
      await client.query('RELEASE SAVEPOINT health_read');
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT health_read');
      logger.warn({ err: error }, 'daily ledger check failed');
    }
    await client.query(`INSERT INTO ops.matriz_ledger_health_checks
      (environment,checked_on,checked_at,status,error_signals,pending_signals)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(environment) DO UPDATE
      SET checked_on=EXCLUDED.checked_on,checked_at=EXCLUDED.checked_at,status=EXCLUDED.status,
          error_signals=EXCLUDED.error_signals,pending_signals=EXCLUDED.pending_signals`,
    [environment, day, now.toISOString(), status, errors, pending]);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export async function latestLedgerHealth(environment: 'prod' | 'test', db: Pool) {
  if (!env.MATRIZ_CENTRAL_LEDGER) return null;
  const result = await db.query<DailyLedgerHealth>(`SELECT status,checked_at::text,error_signals,pending_signals
    FROM ops.matriz_ledger_health_checks WHERE environment=$1`, [environment]);
  return result.rows[0] ?? null;
}

export function startDailyLedgerHealth(): () => void {
  let running = false, stopped = false;
  const check = async () => {
    if (running || stopped) return;
    running = true;
    try { await checkDailyLedgerHealth(); }
    catch (error) { logger.warn({ err: error }, 'daily ledger check deferred'); }
    finally { running = false; }
  };
  const timer = setInterval(() => void check(), 60 * 60_000);
  void check();
  return () => { stopped = true; clearInterval(timer); };
}
