import { generateCurrentMatrizPartnerMonthlyFees } from './admin/painel/queries-mensalidades.js';
import { pool } from './persistence/db.js';
import { env } from './shared/config/env.js';
import { logger } from './shared/logger.js';

const MONTHLY_CONTINUITY_INTERVAL_MS = 60 * 60_000;

interface StaffRolloverResult {
  environment: 'prod' | 'test';
  current_month: string;
  periods_closed: number;
  payables_created: number;
}

interface PayrollSeedResult {
  environment: 'prod' | 'test'; current_month: string; periods_created: number;
}

export async function runMonthlyContinuityCycle(): Promise<{
  monthly_fees_created: number;
  staff_commissions: StaffRolloverResult;
  staff_payroll: PayrollSeedResult;
}> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const monthlyFees = await generateCurrentMatrizPartnerMonthlyFees(
      client,
      env.FAREJADOR_ENV,
    );
    const staff = await client.query<{ result: StaffRolloverResult }>(
      `SELECT finance.run_partner_staff_commission_rollover($1::env_t) AS result`,
      [env.FAREJADOR_ENV],
    );
    const payroll = await client.query<{ result: PayrollSeedResult }>(
      `SELECT finance.run_partner_staff_payroll_seed($1::env_t) AS result`,
      [env.FAREJADOR_ENV],
    );
    await client.query('COMMIT');
    return {
      monthly_fees_created: monthlyFees,
      staff_commissions: staff.rows[0]!.result,
      staff_payroll: payroll.rows[0]!.result,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function startMonthlyContinuityScheduler(): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const loop = async (): Promise<void> => {
    if (stopped) return;
    try {
      const result = await runMonthlyContinuityCycle();
      logger.info(result, 'monthly continuity cycle completed');
    } catch (error) {
      // Deploy sem a migration ainda aplicada nao derruba o sistema. O proximo
      // ciclo recupera automaticamente todas as competencias que ficaram para tras.
      logger.warn({ err: error }, 'monthly continuity cycle deferred');
    }
    if (!stopped) {
      timer = setTimeout(() => void loop(), MONTHLY_CONTINUITY_INTERVAL_MS);
    }
  };

  void loop();
  logger.info('monthly continuity scheduler started');
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
