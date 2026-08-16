/**
 * Gate de integridade de producao. Todas as consultas rodam em uma transacao
 * REPEATABLE READ + READ ONLY e a sessao sempre termina em ROLLBACK.
 *
 * Uso:
 *   node --env-file=.env.preview.pooler scripts/auditar-integridade-prod-readonly.cjs
 */
const { Client } = require('pg');

if (process.env.FAREJADOR_ENV !== 'prod') {
  throw new Error('prod_environment_required');
}
if (!process.env.DATABASE_URL) throw new Error('database_url_required');

async function scalar(client, sql, params = []) {
  const result = await client.query(sql, params);
  return result.rows[0]?.value ?? null;
}

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL lock_timeout = '2s'");

    const transactionReadOnly = await scalar(
      client,
      "SELECT current_setting('transaction_read_only') AS value",
    );
    if (transactionReadOnly !== 'on') throw new Error('read_only_not_enforced');

    const schemaObjects = await client.query(`
      SELECT expected.object_name,
             CASE expected.object_kind
               WHEN 'table' THEN to_regclass(expected.object_name) IS NOT NULL
               WHEN 'function' THEN to_regprocedure(expected.object_name) IS NOT NULL
             END AS present
        FROM (VALUES
          ('table', 'raw.delivery_seen'),
          ('table', 'raw.raw_events'),
          ('table', 'core.contacts'),
          ('table', 'core.conversations'),
          ('table', 'core.messages'),
          ('table', 'network.partner_units'),
          ('table', 'network.partner_access_tokens'),
          ('table', 'network.partner_sessions'),
          ('table', 'finance.matriz_ledger_transactions'),
          ('table', 'finance.matriz_ledger_entries'),
          ('function', 'finance.matriz_stage3_ledger_reconciliation(env_t)')
        ) AS expected(object_kind, object_name)
       ORDER BY expected.object_name
    `);

    const latestMigration = await client.query(`
      SELECT count(*)::int AS count,
             max(version)::text AS latest_version
        FROM supabase_migrations.schema_migrations
    `);
    const permissionColumn = await scalar(client, `
      SELECT EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema='network'
           AND table_name='matriz_collaborator_operation_permissions'
           AND column_name='allow_estoque'
      ) AS value
    `);

    const rawLast24h = await client.query(`
      SELECT processing_status, count(*)::int AS count
        FROM raw.raw_events
       WHERE environment='prod' AND received_at >= now() - interval '24 hours'
       GROUP BY processing_status
       ORDER BY processing_status
    `);
    const rawHealth = {
      pending_older_than_5m: await scalar(client, `
        SELECT count(*)::int AS value
          FROM raw.raw_events
         WHERE environment='prod' AND processing_status='pending'
           AND received_at < now() - interval '5 minutes'
      `),
      failed_last_24h: await scalar(client, `
        SELECT count(*)::int AS value
          FROM raw.raw_events
         WHERE environment='prod' AND processing_status='failed'
           AND received_at >= now() - interval '24 hours'
      `),
      duplicate_delivery_ids: await scalar(client, `
        SELECT count(*)::int AS value FROM (
          SELECT chatwoot_delivery_id
            FROM raw.raw_events
           WHERE environment='prod'
           GROUP BY chatwoot_delivery_id HAVING count(*) > 1
        ) duplicates
      `),
      delivery_pointer_mismatches: await scalar(client, `
        SELECT count(*)::int AS value
          FROM raw.delivery_seen seen
         WHERE seen.environment='prod'
           AND seen.raw_event_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM raw.raw_events event
              WHERE event.environment=seen.environment
                AND event.id=seen.raw_event_id
                AND event.chatwoot_delivery_id=seen.chatwoot_delivery_id
           )
      `),
    };

    const normalizedIntegrity = {
      duplicate_contacts: await scalar(client, `
        SELECT count(*)::int AS value FROM (
          SELECT chatwoot_contact_id FROM core.contacts
           WHERE environment='prod'
           GROUP BY chatwoot_contact_id HAVING count(*) > 1
        ) duplicates
      `),
      duplicate_conversations: await scalar(client, `
        SELECT count(*)::int AS value FROM (
          SELECT chatwoot_conversation_id FROM core.conversations
           WHERE environment='prod'
           GROUP BY chatwoot_conversation_id HAVING count(*) > 1
        ) duplicates
      `),
      duplicate_messages_cross_partition: await scalar(client, `
        SELECT count(*)::int AS value FROM (
          SELECT chatwoot_message_id FROM core.messages
           WHERE environment='prod'
           GROUP BY chatwoot_message_id HAVING count(*) > 1
        ) duplicates
      `),
      conversation_contact_environment_mismatches: await scalar(client, `
        SELECT count(*)::int AS value
          FROM core.conversations conversation
         WHERE conversation.environment='prod'
           AND conversation.contact_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM core.contacts contact
              WHERE contact.environment=conversation.environment
                AND contact.id=conversation.contact_id
           )
      `),
      message_conversation_environment_mismatches: await scalar(client, `
        SELECT count(*)::int AS value
          FROM core.messages message
         WHERE message.environment='prod'
           AND NOT EXISTS (
             SELECT 1 FROM core.conversations conversation
              WHERE conversation.environment=message.environment
                AND conversation.id=message.conversation_id
           )
      `),
    };

    const ledgerIntegrity = {
      transactions: await scalar(client, `
        SELECT count(*)::int AS value
          FROM finance.matriz_ledger_transactions WHERE environment='prod'
      `),
      unbalanced_transactions: await scalar(client, `
        SELECT count(*)::int AS value
          FROM (
            SELECT transaction.id, transaction.amount,
                   count(entry.id) AS lines,
                   coalesce(sum(entry.amount) FILTER (WHERE entry.side='debit'), 0) AS debits,
                   coalesce(sum(entry.amount) FILTER (WHERE entry.side='credit'), 0) AS credits
              FROM finance.matriz_ledger_transactions transaction
              LEFT JOIN finance.matriz_ledger_entries entry
                ON entry.environment=transaction.environment
               AND entry.transaction_id=transaction.id
             WHERE transaction.environment='prod'
             GROUP BY transaction.id, transaction.amount
            HAVING count(entry.id) < 2
                OR coalesce(sum(entry.amount) FILTER (WHERE entry.side='debit'), 0) <> transaction.amount
                OR coalesce(sum(entry.amount) FILTER (WHERE entry.side='credit'), 0) <> transaction.amount
          ) invalid
      `),
      entry_environment_mismatches: await scalar(client, `
        SELECT count(*)::int AS value
          FROM finance.matriz_ledger_entries entry
          JOIN finance.matriz_ledger_transactions transaction
            ON transaction.id=entry.transaction_id
         WHERE entry.environment='prod'
           AND transaction.environment<>entry.environment
      `),
      stage3_reconciliation: (await client.query(
        "SELECT finance.matriz_stage3_ledger_reconciliation('prod'::env_t) AS value",
      )).rows[0]?.value ?? null,
    };

    const partnerRole = await client.query(`
      SELECT rolname, rolsuper, rolbypassrls, rolcanlogin
        FROM pg_roles WHERE rolname='farejador_partner_app'
    `);
    const partnerRls = await client.query(`
      SELECT expected.schema_name, expected.table_name,
             class.oid IS NOT NULL AS present,
             coalesce(class.relrowsecurity, false) AS rls_enabled,
             coalesce(class.relforcerowsecurity, false) AS rls_forced
        FROM (VALUES
          ('network', 'partners'),
          ('network', 'partner_units'),
          ('network', 'partner_access_tokens'),
          ('commerce', 'partner_orders'),
          ('commerce', 'partner_order_items'),
          ('commerce', 'partner_purchases'),
          ('commerce', 'partner_purchase_items'),
          ('commerce', 'partner_stock_levels'),
          ('commerce', 'partner_customers'),
          ('commerce', 'partner_conversations'),
          ('commerce', 'partner_messages'),
          ('finance', 'partner_expenses'),
          ('finance', 'partner_payables'),
          ('finance', 'partner_receivables'),
          ('finance', 'partner_receivable_installments')
        ) AS expected(schema_name, table_name)
        LEFT JOIN pg_namespace namespace
          ON namespace.nspname=expected.schema_name
        LEFT JOIN pg_class class
          ON class.relnamespace=namespace.oid
         AND class.relname=expected.table_name
         AND class.relkind IN ('r', 'p')
       ORDER BY expected.schema_name, expected.table_name
    `);
    const sessionTableAcl = await client.query(`
      SELECT coalesce(role.rolname, 'PUBLIC') AS grantee, acl.privilege_type
        FROM pg_class class
        JOIN pg_namespace namespace ON namespace.oid=class.relnamespace
        CROSS JOIN LATERAL aclexplode(
          coalesce(class.relacl, acldefault('r', class.relowner))
        ) acl
        LEFT JOIN pg_roles role ON role.oid=acl.grantee
       WHERE namespace.nspname='network'
         AND class.relname='partner_sessions'
         AND (acl.grantee=0 OR role.rolname='farejador_partner_app')
       ORDER BY grantee, acl.privilege_type
    `);
    const sessionFunctionAcl = await client.query(`
      SELECT coalesce(role.rolname, 'PUBLIC') AS grantee, acl.privilege_type
        FROM pg_proc procedure
        JOIN pg_namespace namespace ON namespace.oid=procedure.pronamespace
        CROSS JOIN LATERAL aclexplode(
          coalesce(procedure.proacl, acldefault('f', procedure.proowner))
        ) acl
        LEFT JOIN pg_roles role ON role.oid=acl.grantee
       WHERE namespace.nspname='network'
         AND procedure.proname='validate_partner_session'
         AND pg_get_function_identity_arguments(procedure.oid)='p_environment text, p_slug text, p_session text'
         AND (acl.grantee=0 OR role.rolname='farejador_partner_app')
       ORDER BY grantee, acl.privilege_type
    `);

    const allZero = (object) => Object.values(object).every((value) => value === 0);
    const reconciliationValues = Object.values(ledgerIntegrity.stage3_reconciliation ?? {});
    const checks = {
      transaction_read_only: transactionReadOnly === 'on',
      required_schema_present: schemaObjects.rows.every((row) => row.present),
      latest_permission_column_present: permissionColumn === true,
      raw_integrity: allZero(rawHealth),
      normalized_integrity: allZero(normalizedIntegrity),
      ledger_balanced: ledgerIntegrity.unbalanced_transactions === 0
        && ledgerIntegrity.entry_environment_mismatches === 0,
      stage3_reconciled: reconciliationValues.every((value) => Number(value) === 0),
      partner_role_least_privilege: partnerRole.rows.length === 1
        && partnerRole.rows[0].rolsuper === false
        && partnerRole.rows[0].rolbypassrls === false,
      partner_sessions_direct_access_blocked: sessionTableAcl.rows.length === 0,
      partner_session_validator_restricted: sessionFunctionAcl.rows.length === 1
        && sessionFunctionAcl.rows[0].grantee === 'farejador_partner_app'
        && sessionFunctionAcl.rows[0].privilege_type === 'EXECUTE',
      partner_tables_rls_enabled: partnerRls.rows.length > 0
        && partnerRls.rows.every((row) => row.present && row.rls_enabled),
    };

    console.log(JSON.stringify({
      mode: 'repeatable_read_read_only',
      environment: 'prod',
      checks,
      verdict: Object.values(checks).every(Boolean) ? 'PASS' : 'REVIEW',
      migrations: {
        count: latestMigration.rows[0]?.count ?? 0,
        latest_version: latestMigration.rows[0]?.latest_version ?? null,
        permission_0176_present: permissionColumn,
      },
      required_schema: schemaObjects.rows,
      raw: { last_24h: rawLast24h.rows, ...rawHealth },
      normalized: normalizedIntegrity,
      ledger: ledgerIntegrity,
      access_control: {
        partner_role: partnerRole.rows,
        partner_tables: partnerRls.rows,
        partner_sessions_table_acl: sessionTableAcl.rows,
        partner_session_validator_acl: sessionFunctionAcl.rows,
      },
    }, null, 2));

    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`AUDIT_FAILED:${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
