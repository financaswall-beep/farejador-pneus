import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const EXPECTED_AUTHORIZATION = 'LEDGER-PROD-2026-07-27';
const EXPECTED_DATABASE_HOST = 'db.aoqtgwzeyznycuakrdhp.supabase.co';
const EXPECTED_BACKUP_HASH =
  'B14A6581E64EF5183430EC71CD77A78C90070FB90DF9C103B47837FC2CB2D744';

function assertProductionGuards(): void {
  if (process.env.ALLOW_PROD_LEDGER_BACKFILL !== EXPECTED_AUTHORIZATION) {
    throw new Error('explicit_backfill_authorization_required');
  }
  if (process.env.FAREJADOR_ENV !== 'prod') {
    throw new Error('prod_environment_required');
  }
  if (process.env.MATRIZ_CENTRAL_LEDGER !== 'true'
    || process.env.MATRIZ_CENTRAL_LEDGER_READ === 'true') {
    throw new Error('writer_on_reader_off_required');
  }
  const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
  if (databaseUrl.hostname !== EXPECTED_DATABASE_HOST) {
    throw new Error(`unexpected_database_host:${databaseUrl.hostname}`);
  }
  const backupPath = process.env.PROD_BACKUP_FILE;
  if (!backupPath) throw new Error('verified_backup_required');
  const backupHash = createHash('sha256')
    .update(readFileSync(backupPath)).digest('hex').toUpperCase();
  if (backupHash !== EXPECTED_BACKUP_HASH) {
    throw new Error('backup_hash_mismatch');
  }
}

function sumProcessed(value: unknown): number {
  if (typeof value === 'number') return value;
  if (!value || typeof value !== 'object') return 0;
  return Object.values(value).reduce<number>(
    (total, item) => total + sumProcessed(item),
    0,
  );
}

async function main(): Promise<void> {
  assertProductionGuards();

  const [{ pool }, integration, competence, stage3Module, stage4Module, stage5Module] =
    await Promise.all([
      import('../src/persistence/db.js'),
      import('../src/admin/painel/matriz-ledger-integration-health.js'),
      import('../src/admin/painel/matriz-ledger-competence-gate.js'),
      import('../src/admin/painel/matriz-ledger-stage3-report.js'),
      import('../src/admin/painel/matriz-ledger-stage4-reconciliation.js'),
      import('../src/admin/painel/matriz-ledger-stage5-reconciliation.js'),
    ]);

  const lockClient = await pool.connect();
  try {
    await lockClient.query(
      `SELECT pg_advisory_lock(hashtext('farejador:ledger:prod-backfill'))`,
    );
    const centralBefore = await lockClient.query<{
      transactions: number; entries: number; payments: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM finance.matriz_ledger_transactions
           WHERE environment='prod') transactions,
         (SELECT count(*)::int FROM finance.matriz_ledger_entries
           WHERE environment='prod') entries,
         (SELECT count(*)::int FROM finance.matriz_ledger_payments
           WHERE environment='prod') payments`,
    );
    if (Object.values(centralBefore.rows[0]).some((count) => count !== 0)) {
      throw new Error(
        `central_ledger_not_empty:${JSON.stringify(centralBefore.rows[0])}`,
      );
    }

    const healthBefore =
      await integration.getMatrizLedgerIntegrationHealth('prod', pool);
    const firstPass = await integration.runMatrizLedgerIntegrationBackfill(
      { environment: 'prod', limit: 5_000 },
      pool,
    );
    const secondPass = await integration.runMatrizLedgerIntegrationBackfill(
      { environment: 'prod', limit: 5_000 },
      pool,
    );
    if (sumProcessed(secondPass.processed) !== 0) {
      throw new Error(
        `backfill_not_idempotent:${JSON.stringify(secondPass.processed)}`,
      );
    }

    const healthAfter =
      await integration.getMatrizLedgerIntegrationHealth('prod', pool);
    const [stage3, stage4, stage5] = await Promise.all([
      stage3Module.getMatrizStage3LedgerReconciliation('prod', pool),
      stage4Module.getMatrizStage4LedgerReconciliation('prod', pool),
      stage5Module.getMatrizStage5LedgerReconciliation('prod', pool),
    ]);
    const monthRows = await pool.query<{ competence: string }>(
      `WITH source_dates(value) AS (
         SELECT (sold_at AT TIME ZONE 'America/Sao_Paulo')::date
           FROM commerce.wholesale_orders WHERE environment='prod'
         UNION ALL
         SELECT (created_at AT TIME ZONE 'America/Sao_Paulo')::date
           FROM commerce.orders WHERE environment='prod'
         UNION ALL
         SELECT (purchased_at AT TIME ZONE 'America/Sao_Paulo')::date
           FROM commerce.wholesale_purchases WHERE environment='prod'
         UNION ALL
         SELECT (occurred_at AT TIME ZONE 'America/Sao_Paulo')::date
           FROM commerce.matriz_expenses WHERE environment='prod'
         UNION ALL
         SELECT metric_date
           FROM marketing.meta_insights_daily WHERE environment='prod'
       )
       SELECT to_char(date_trunc('month',value)::date,'YYYY-MM-01') competence
         FROM source_dates WHERE value IS NOT NULL
        GROUP BY date_trunc('month',value)
        ORDER BY date_trunc('month',value) DESC LIMIT 2`,
    );
    const competences = monthRows.rows.map((row) => row.competence).sort();
    if (competences.length < 2) throw new Error('two_competences_required');
    const gate = await competence.getMatrizLedgerCompetenceGate(
      competences,
      'prod',
      pool,
    );

    const invalidStatuses = [
      healthAfter.status,
      stage3.status,
      stage4.status,
      stage5.status,
      gate.status,
    ].filter((status) => status !== 'green');
    if (invalidStatuses.length > 0
      || healthAfter.global.total_error_signals !== 0
      || Number(gate.total_abs_difference) !== 0) {
      throw new Error(`production_gate_failed:${JSON.stringify({
        health: healthAfter.status,
        errors: healthAfter.global.total_error_signals,
        stage3: stage3.status,
        stage4: stage4.status,
        stage5: stage5.status,
        competence: gate.status,
        difference: gate.total_abs_difference,
      })}`);
    }

    const centralAfter = await pool.query<{
      transactions: number; entries: number; payments: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM finance.matriz_ledger_transactions
           WHERE environment='prod') transactions,
         (SELECT count(*)::int FROM finance.matriz_ledger_entries
           WHERE environment='prod') entries,
         (SELECT count(*)::int FROM finance.matriz_ledger_payments
           WHERE environment='prod') payments`,
    );
    console.log(JSON.stringify({
      target: EXPECTED_DATABASE_HOST,
      environment: 'prod',
      flags: { writer_for_command: true, reader: false },
      health_before: {
        status: healthBefore.status,
        errors: healthBefore.global.total_error_signals,
      },
      first_pass: firstPass.processed,
      second_pass: secondPass.processed,
      health_after: {
        status: healthAfter.status,
        errors: healthAfter.global.total_error_signals,
        modules: healthAfter.modules,
      },
      reconciliation: {
        stage3: stage3.status,
        stage4: stage4.status,
        stage5: stage5.status,
      },
      competence_gate: {
        competences,
        status: gate.status,
        total_abs_difference: gate.total_abs_difference,
      },
      central_rows: centralAfter.rows[0],
    }, null, 2));
  } finally {
    await lockClient.query(
      `SELECT pg_advisory_unlock(hashtext('farejador:ledger:prod-backfill'))`,
    ).catch(() => undefined);
    lockClient.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(
    `PROD_BACKFILL_FAILED:${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
