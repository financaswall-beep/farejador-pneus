#!/usr/bin/env node
'use strict';

/* eslint-disable no-console */

/**
 * Limpeza seletiva dos dados de teste confirmada pelo dono em 2026-07-27.
 *
 * Apaga:
 * - conversas normalizadas, estado do atendente e dados analíticos;
 * - clientes, pedidos, compras e logística transacional;
 * - financeiro central, financeiro do parceiro, comissões e folha;
 * - dados transacionais de Marketing;
 * - colaboradores da Matriz, exceto contas owner ativas.
 *
 * Preserva:
 * - raw.raw_events e raw.delivery_seen;
 * - parceiros, unidades, acessos, permissões e sessões do parceiro;
 * - catálogo, preços, pneus, fornecedores e saldos de estoque;
 * - conta(s) owner ativa(s), suas identidades e sessões;
 * - categorias, regras, geografia, funções, triggers e views.
 *
 * Reservas de estoque ligadas aos pedidos apagados são liberadas. Quantidades
 * físicas/disponíveis, preços, custos e demais campos de estoque ficam intactos.
 *
 * Simulação:
 *   ALLOW_PRODUCTION_CLEANUP=1 node --env-file=.env.pooler \
 *     scripts/limpar-dados-teste-seletivo-prod.cjs
 *
 * Commit:
 *   ALLOW_PRODUCTION_CLEANUP=1 COMMIT=1 \
 *     node --env-file=.env.pooler \
 *     scripts/limpar-dados-teste-seletivo-prod.cjs \
 *     --confirm=APAGAR_DADOS_TESTE
 */

const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
const COMMIT = process.env.COMMIT === '1';
const ALLOWED = process.env.ALLOW_PRODUCTION_CLEANUP === '1';
const CONFIRMED = process.argv.includes('--confirm=APAGAR_DADOS_TESTE');

const APP_SCHEMAS = [
  'raw',
  'core',
  'analytics',
  'ops',
  'commerce',
  'agent',
  'network',
  'finance',
  'marketing',
  'audit',
];

const TARGET_TABLES = [
  'agent.session_current',
  'agent.turns',
  'analytics.conversation_classifications',
  'analytics.conversation_facts',
  'analytics.conversation_signals',
  'analytics.fact_evidence',
  'analytics.linguistic_hints',
  'audit.operation_idempotency',
  'commerce.customer_identities',
  'commerce.customer_identity_candidates',
  'commerce.customer_identity_links',
  'commerce.customers',
  'commerce.fitment_discoveries',
  'commerce.matriz_delivery_trips',
  'commerce.matriz_expenses',
  'commerce.matriz_trip_receipt_ai_attempts',
  'commerce.matriz_trip_receipt_blobs',
  'commerce.matriz_trip_receipt_decisions',
  'commerce.matriz_trip_receipts',
  'commerce.order_items',
  'commerce.orders',
  'commerce.partner_conversations',
  'commerce.partner_customers',
  'commerce.partner_dismissed_items',
  'commerce.partner_messages',
  'commerce.partner_order_items',
  'commerce.partner_orders',
  'commerce.partner_purchase_items',
  'commerce.partner_purchases',
  'commerce.photo_request_blobs',
  'commerce.photo_requests',
  'commerce.satisfaction_surveys',
  'commerce.wholesale_customers',
  'commerce.wholesale_order_items',
  'commerce.wholesale_orders',
  'commerce.wholesale_purchase_items',
  'commerce.wholesale_purchases',
  'commerce.wholesale_stock_movements',
  'core.contacts',
  'core.conversation_assignments',
  'core.conversation_status_events',
  'core.conversation_tags',
  'core.conversations',
  'core.message_attachments',
  'core.message_reactions',
  'core.messages',
  'finance.matriz_commission_reversals',
  'finance.matriz_inventory_adjustments',
  'finance.matriz_ledger_entries',
  'finance.matriz_ledger_payments',
  'finance.matriz_ledger_transactions',
  'finance.matriz_partner_monthly_fees',
  'finance.matriz_payroll_adjustments',
  'finance.matriz_payroll_items',
  'finance.matriz_payroll_periods',
  'finance.partner_expenses',
  'finance.partner_payables',
  'finance.partner_receivable_installments',
  'finance.partner_receivables',
  'marketing.ad_referrals',
  'marketing.capi_outbox',
  'marketing.meta_insights_daily',
  'marketing.meta_sync_runs',
  'marketing.order_attributions',
  'network.commission_entries',
  'network.commission_entry_events',
  'network.matriz_collaborator_commission_rules',
  'network.matriz_collaborator_compensation',
  'ops.atendente_dead_letters',
  'ops.atendente_job_events',
  'ops.atendente_jobs',
  'ops.erasure_log',
  'ops.outbound_message_events',
  'ops.outbound_messages',
  'ops.privacy_request_events',
  'ops.privacy_requests',
].sort();

const PARTIAL_TABLES = [
  'commerce.partner_stock_levels',
  'commerce.stock_levels',
  'network.matriz_collaborators',
  'network.matriz_staff_sessions',
  'network.partner_people',
].sort();

const PROTECTED_TABLES = [
  'commerce.delivery_zones',
  'commerce.geo_cache',
  'commerce.geo_resolutions',
  'commerce.import_batches',
  'commerce.import_errors',
  'commerce.matriz_expense_categories',
  'commerce.partner_push_subscriptions',
  'commerce.product_media',
  'commerce.product_prices',
  'commerce.products',
  'commerce.store_policies',
  'commerce.tire_specs',
  'commerce.vehicle_fitments',
  'commerce.vehicle_models',
  'commerce.wholesale_stock',
  'commerce.wholesale_suppliers',
  'core.units',
  'network.partner_access_tokens',
  'network.partner_applications',
  'network.partner_sessions',
  'network.partner_token_commission',
  'network.partner_token_permissions',
  'network.partner_unit_permissions',
  'network.partner_units',
  'network.partners',
  'network.unit_coverage',
].sort();

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function qualifiedName(value) {
  const [schema, table] = value.split('.');
  if (!schema || !table) throw new Error(`invalid_table_name:${value}`);
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

async function assertTablesExist(client, tables) {
  for (const table of tables) {
    const result = await client.query('SELECT to_regclass($1)::text table_name', [table]);
    if (result.rows[0]?.table_name == null) {
      throw new Error(`required_table_missing:${table}`);
    }
  }
}

async function countRows(client, tables) {
  const counts = {};
  for (const table of tables) {
    const result = await client.query(
      `SELECT count(*)::int rows FROM ${qualifiedName(table)}`,
    );
    counts[table] = result.rows[0].rows;
  }
  return counts;
}

async function fingerprint(client, table, expression = 'to_jsonb(t)') {
  const result = await client.query(
    `SELECT count(*)::int rows,
            md5(COALESCE(string_agg(row_hash,',' ORDER BY row_hash),'')) fingerprint
       FROM (
         SELECT md5((${expression})::text) row_hash
           FROM ${qualifiedName(table)} t
       ) data`,
  );
  return result.rows[0];
}

async function fingerprints(client, tables) {
  const result = {};
  for (const table of tables) result[table] = await fingerprint(client, table);
  return result;
}

async function objectCounts(client) {
  const result = await client.query(
    `SELECT
       (SELECT count(*)::int
          FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname=ANY($1::text[])
           AND c.relkind IN ('r','p')
           AND NOT c.relispartition) tables,
       (SELECT count(*)::int
          FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname=ANY($1::text[])) functions,
       (SELECT count(*)::int
          FROM pg_trigger t
          JOIN pg_class c ON c.oid=t.tgrelid
          JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname=ANY($1::text[]) AND NOT t.tgisinternal) triggers,
       (SELECT count(*)::int
          FROM pg_views v WHERE v.schemaname=ANY($1::text[])) views,
       (SELECT count(*)::int
          FROM pg_matviews v WHERE v.schemaname=ANY($1::text[])) materialized_views`,
    [APP_SCHEMAS],
  );
  return result.rows[0];
}

async function stockSnapshot(client) {
  const matrix = await fingerprint(
    client,
    'commerce.stock_levels',
    `to_jsonb(t) - 'quantity_reserved' - 'updated_at'`,
  );
  const partner = await fingerprint(
    client,
    'commerce.partner_stock_levels',
    `to_jsonb(t) - 'quantity_reserved' - 'updated_at'`,
  );
  const wholesale = await fingerprint(client, 'commerce.wholesale_stock');
  const reservations = await client.query(
    `SELECT
       (SELECT COALESCE(sum(quantity_reserved),0)::int
          FROM commerce.stock_levels) matrix_reserved,
       (SELECT COALESCE(sum(quantity_reserved),0)::int
          FROM commerce.partner_stock_levels) partner_reserved`,
  );
  return {
    matrix,
    partner,
    wholesale,
    reservations: reservations.rows[0],
  };
}

async function ownerSnapshot(client) {
  const result = await client.query(
    `SELECT
       count(*) FILTER (
         WHERE mc.environment='prod'
           AND mc.panel_role='owner'
           AND mc.revoked_at IS NULL
           AND pp.revoked_at IS NULL
           AND pp.password_hash IS NOT NULL
       )::int prod_login_ready,
       count(*) FILTER (
         WHERE mc.panel_role='owner'
           AND mc.revoked_at IS NULL
           AND pp.revoked_at IS NULL
           AND pp.password_hash IS NOT NULL
       )::int all_login_ready,
       count(*) FILTER (
         WHERE mc.panel_role IS DISTINCT FROM 'owner'
            OR mc.revoked_at IS NOT NULL
            OR pp.revoked_at IS NOT NULL
       )::int removable_collaborators
     FROM network.matriz_collaborators mc
     JOIN network.partner_people pp ON pp.id=mc.person_id`,
  );
  return result.rows[0];
}

function assertEqual(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `guard_changed:${label}:before=${JSON.stringify(expected)}:after=${JSON.stringify(actual)}`,
    );
  }
}

async function main() {
  if (!DATABASE_URL) throw new Error('database_url_required');
  if (!ALLOWED) throw new Error('allow_production_cleanup_required');
  if (COMMIT && !CONFIRMED) throw new Error('explicit_confirmation_required');

  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  let transactionOpen = false;
  try {
    const allManagedTables = [
      ...new Set([...TARGET_TABLES, ...PARTIAL_TABLES, ...PROTECTED_TABLES]),
    ];
    await assertTablesExist(client, allManagedTables);

    await client.query('BEGIN');
    transactionOpen = true;
    await client.query(`SET LOCAL lock_timeout='20s'`);
    await client.query(`SET LOCAL statement_timeout='180s'`);
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('farejador:test-data-cleanup:v1',0))`,
    );

    await client.query(
      `LOCK TABLE ${[...TARGET_TABLES, ...PARTIAL_TABLES]
        .sort()
        .map(qualifiedName)
        .join(', ')} IN ACCESS EXCLUSIVE MODE`,
    );
    await client.query(
      `LOCK TABLE ${PROTECTED_TABLES
        .map(qualifiedName)
        .join(', ')} IN SHARE MODE`,
    );

    const structureBefore = await objectCounts(client);
    const protectedBefore = await fingerprints(client, PROTECTED_TABLES);
    const stockBefore = await stockSnapshot(client);
    const ownersBefore = await ownerSnapshot(client);
    const targetBefore = await countRows(client, TARGET_TABLES);
    const rawBefore = await countRows(client, ['raw.raw_events', 'raw.delivery_seen']);
    const auditEventsBefore = await countRows(client, ['audit.events']);

    if (ownersBefore.prod_login_ready !== 1) {
      throw new Error(
        `owner_guard_failed:expected_one_prod_owner:found=${ownersBefore.prod_login_ready}`,
      );
    }

    await client.query(
      `CREATE TEMP TABLE cleanup_removed_people_20260727
         ON COMMIT DROP
       AS
       SELECT DISTINCT mc.person_id
         FROM network.matriz_collaborators mc
         JOIN network.partner_people pp ON pp.id=mc.person_id
        WHERE NOT COALESCE((
          mc.panel_role='owner'
          AND mc.revoked_at IS NULL
          AND pp.revoked_at IS NULL
        ),false)`,
    );

    await client.query(
      `TRUNCATE TABLE ${TARGET_TABLES.map(qualifiedName).join(', ')}`,
    );

    const matrixReservations = await client.query(
      `UPDATE commerce.stock_levels
          SET quantity_reserved=0
        WHERE quantity_reserved<>0`,
    );
    const partnerReservations = await client.query(
      `UPDATE commerce.partner_stock_levels
          SET quantity_reserved=0
        WHERE quantity_reserved<>0`,
    );

    const deletedStaffSessions = await client.query(
      `DELETE FROM network.matriz_staff_sessions session
        WHERE NOT EXISTS (
          SELECT 1
            FROM network.matriz_collaborators mc
            JOIN network.partner_people pp ON pp.id=mc.person_id
           WHERE mc.person_id=session.person_id
             AND mc.environment=session.environment
             AND mc.panel_role='owner'
             AND mc.revoked_at IS NULL
             AND pp.revoked_at IS NULL
        )`,
    );
    const deletedCollaborators = await client.query(
      `DELETE FROM network.matriz_collaborators mc
        USING network.partner_people pp
        WHERE pp.id=mc.person_id
          AND NOT COALESCE((
            mc.panel_role='owner'
            AND mc.revoked_at IS NULL
            AND pp.revoked_at IS NULL
          ),false)`,
    );
    const deletedPeople = await client.query(
      `DELETE FROM network.partner_people pp
        USING cleanup_removed_people_20260727 candidate
        WHERE pp.id=candidate.person_id
          AND NOT EXISTS (
            SELECT 1 FROM network.partner_access_tokens pat
             WHERE pat.person_id=pp.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM network.matriz_collaborators mc
             WHERE mc.person_id=pp.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM network.matriz_staff_sessions session
             WHERE session.person_id=pp.id
          )`,
    );

    const targetAfter = await countRows(client, TARGET_TABLES);
    const remainingTargets = Object.entries(targetAfter)
      .filter(([, rows]) => rows !== 0);
    if (remainingTargets.length > 0) {
      throw new Error(`target_tables_not_empty:${JSON.stringify(remainingTargets)}`);
    }

    const ownersAfter = await ownerSnapshot(client);
    if (ownersAfter.prod_login_ready !== ownersBefore.prod_login_ready
      || ownersAfter.all_login_ready !== ownersBefore.all_login_ready
      || ownersAfter.removable_collaborators !== 0) {
      throw new Error(
        `owner_guard_changed:before=${JSON.stringify(ownersBefore)}:after=${JSON.stringify(ownersAfter)}`,
      );
    }

    const brokenPartnerPeople = await client.query(
      `SELECT count(*)::int rows
         FROM network.partner_access_tokens pat
         LEFT JOIN network.partner_people pp ON pp.id=pat.person_id
        WHERE pat.person_id IS NOT NULL
          AND pp.id IS NULL`,
    );
    if (brokenPartnerPeople.rows[0].rows !== 0) {
      throw new Error(`partner_people_broken:${brokenPartnerPeople.rows[0].rows}`);
    }

    const structureAfter = await objectCounts(client);
    assertEqual(structureAfter, structureBefore, 'database_structure');

    const protectedAfter = await fingerprints(client, PROTECTED_TABLES);
    assertEqual(protectedAfter, protectedBefore, 'protected_partner_catalog_reference_data');

    const stockAfter = await stockSnapshot(client);
    assertEqual(stockAfter.matrix, stockBefore.matrix, 'matrix_stock_balance');
    assertEqual(stockAfter.partner, stockBefore.partner, 'partner_stock_balance');
    assertEqual(stockAfter.wholesale, stockBefore.wholesale, 'wholesale_stock_balance');
    if (stockAfter.reservations.matrix_reserved !== 0
      || stockAfter.reservations.partner_reserved !== 0) {
      throw new Error(`stock_reservations_not_zero:${JSON.stringify(stockAfter.reservations)}`);
    }

    const rawAfter = await countRows(client, ['raw.raw_events', 'raw.delivery_seen']);
    assertEqual(rawAfter, rawBefore, 'immutable_raw_layer');
    const auditEventsAfter = await countRows(client, ['audit.events']);
    if (auditEventsAfter['audit.events'] < auditEventsBefore['audit.events']) {
      throw new Error('audit_events_were_removed');
    }

    const removed = Object.fromEntries(
      Object.entries(targetBefore).filter(([, rows]) => rows > 0),
    );
    const report = {
      mode: COMMIT ? 'commit' : 'dry_run',
      removed_rows_by_table: removed,
      removed_rows_total: Object.values(removed)
        .reduce((total, rows) => total + rows, 0),
      collaborators: {
        before: ownersBefore,
        after: ownersAfter,
        deleted_collaborators: deletedCollaborators.rowCount,
        deleted_people_without_partner_link: deletedPeople.rowCount,
        deleted_non_owner_sessions: deletedStaffSessions.rowCount,
      },
      stock: {
        matrix_reservations_released_rows: matrixReservations.rowCount,
        partner_reservations_released_rows: partnerReservations.rowCount,
        before: stockBefore.reservations,
        after: stockAfter.reservations,
      },
      preserved: {
        structure: structureAfter,
        raw: rawAfter,
        audit_events: auditEventsAfter['audit.events'],
        protected_table_fingerprints: 'unchanged',
        prod_owner_login_ready: ownersAfter.prod_login_ready,
        all_owner_logins_ready: ownersAfter.all_login_ready,
      },
    };

    if (COMMIT) {
      await client.query('COMMIT');
      transactionOpen = false;
      console.log(JSON.stringify({ ...report, transaction: 'committed' }, null, 2));
    } else {
      await client.query('ROLLBACK');
      transactionOpen = false;
      console.log(JSON.stringify({ ...report, transaction: 'rolled_back' }, null, 2));
    }
  } catch (error) {
    if (transactionOpen) {
      await client.query('ROLLBACK').catch(() => undefined);
    }
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(
    `SELECTIVE_CLEANUP_FAILED:${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
