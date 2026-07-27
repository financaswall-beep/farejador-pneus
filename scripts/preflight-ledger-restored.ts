import { pool } from '../src/persistence/db.js';
import {
  getMatrizLedgerIntegrationHealth,
  runMatrizLedgerIntegrationBackfill,
} from '../src/admin/painel/matriz-ledger-integration-health.js';
import { getMatrizLedgerCompetenceGate } from
  '../src/admin/painel/matriz-ledger-competence-gate.js';
import { getMatrizStage3LedgerReconciliation } from
  '../src/admin/painel/matriz-ledger-stage3-report.js';
import { getMatrizStage4LedgerReconciliation } from
  '../src/admin/painel/matriz-ledger-stage4-reconciliation.js';
import { getMatrizStage5LedgerReconciliation } from
  '../src/admin/painel/matriz-ledger-stage5-reconciliation.js';

const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
if (process.env.LEDGER_PREFLIGHT_RESTORED !== 'true'
  || !['127.0.0.1', 'localhost'].includes(databaseUrl.hostname)) {
  throw new Error('restored_local_database_required');
}
if (process.env.FAREJADOR_ENV !== 'prod'
  || process.env.MATRIZ_CENTRAL_LEDGER !== 'true'
  || process.env.MATRIZ_CENTRAL_LEDGER_READ === 'true') {
  throw new Error('safe_preflight_flags_required');
}

async function main() {
  const before = await getMatrizLedgerIntegrationHealth('prod', pool);
  const backfill = await runMatrizLedgerIntegrationBackfill({
    environment: 'prod',
    limit: 5_000,
  }, pool);
  const after = await getMatrizLedgerIntegrationHealth('prod', pool);
  const [stage3, stage4, stage5] = await Promise.all([
    getMatrizStage3LedgerReconciliation('prod', pool),
    getMatrizStage4LedgerReconciliation('prod', pool),
    getMatrizStage5LedgerReconciliation('prod', pool),
  ]);
  const months = await pool.query<{ competence: string }>(
    `WITH source_dates(value) AS (
       SELECT sold_at FROM commerce.wholesale_orders WHERE environment='prod'
       UNION ALL
       SELECT created_at FROM commerce.orders WHERE environment='prod'
       UNION ALL
       SELECT purchased_at FROM commerce.wholesale_purchases WHERE environment='prod'
       UNION ALL
       SELECT occurred_at FROM commerce.matriz_expenses WHERE environment='prod'
       UNION ALL
       SELECT metric_date::timestamptz
         FROM marketing.meta_insights_daily WHERE environment='prod'
     )
     SELECT to_char(date_trunc('month',value),'YYYY-MM-01') competence
       FROM source_dates WHERE value IS NOT NULL
      GROUP BY date_trunc('month',value)
      ORDER BY date_trunc('month',value) DESC LIMIT 2`,
  );
  const competences = months.rows.map((row) => row.competence).sort();
  const gate = competences.length >= 2
    ? await getMatrizLedgerCompetenceGate(competences, 'prod', pool)
    : null;
  console.log(JSON.stringify({
    target: 'restored_local_copy',
    flags: { writer: true, reader: false },
    health_before: {
      status: before.status,
      errors: before.global.total_error_signals,
    },
    processed: backfill.processed,
    health_after: {
      status: after.status,
      errors: after.global.total_error_signals,
      modules: after.modules,
      global: after.global,
    },
    reconciliation: {
      stage3,
      stage4,
      stage5,
    },
    competence_gate: gate && {
      competences,
      status: gate.status,
      total_abs_difference: gate.total_abs_difference,
      differences: gate.competences.flatMap((competence) =>
        competence.origins.filter((origin) => !origin.matched).map((origin) => ({
          competence: competence.competence,
          ...origin,
        }))),
    },
  }, null, 2));
}

main()
  .finally(() => pool.end())
  .catch((error) => {
    console.error(`PREFLIGHT_FAILED:${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
