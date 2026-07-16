import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres';

let db: IntegrationDb;
let conversationId: string;

beforeAll(async () => {
  db = await startPostgres();
});

afterAll(async () => {
  if (db) await stopPostgres(db);
});

beforeEach(async () => {
  // Cria uma conversa nova para isolar cada teste das constraints UNIQUE.
  const result = await db.pool.query<{ id: string }>(
    `INSERT INTO core.conversations
       (environment, chatwoot_conversation_id, chatwoot_account_id,
        current_status, started_at)
     VALUES ('test', $1, 1, 'open', now())
     RETURNING id`,
    [Math.floor(Math.random() * 1_000_000_000)],
  );
  conversationId = result.rows[0].id;
});

describe('migration 0008 — status_events_dedup_key', () => {
  it('rejects duplicate (env, conv, event_type, occurred_at) with 23505', async () => {
    const occurredAt = '2026-04-15T12:00:00Z';
    const insert = `
      INSERT INTO core.conversation_status_events
        (environment, conversation_id, chatwoot_conversation_id,
         event_type, occurred_at)
      VALUES ('test', $1,
              (SELECT chatwoot_conversation_id FROM core.conversations WHERE id=$1),
              'status_changed', $2)
    `;
    await db.pool.query(insert, [conversationId, occurredAt]);
    await expect(db.pool.query(insert, [conversationId, occurredAt])).rejects.toMatchObject({
      code: '23505',
      constraint: 'status_events_dedup_key',
    });
  });

  it('ON CONFLICT ON CONSTRAINT status_events_dedup_key DO NOTHING is idempotent', async () => {
    const occurredAt = '2026-04-15T12:00:00Z';
    const insert = `
      INSERT INTO core.conversation_status_events
        (environment, conversation_id, chatwoot_conversation_id,
         event_type, occurred_at)
      VALUES ('test', $1,
              (SELECT chatwoot_conversation_id FROM core.conversations WHERE id=$1),
              'status_changed', $2)
      ON CONFLICT ON CONSTRAINT status_events_dedup_key DO NOTHING
    `;
    await db.pool.query(insert, [conversationId, occurredAt]);
    const second = await db.pool.query(insert, [conversationId, occurredAt]);
    expect(second.rowCount).toBe(0);

    const count = await db.pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM core.conversation_status_events WHERE conversation_id = $1`,
      [conversationId],
    );
    expect(count.rows[0].c).toBe('1');
  });
});

describe('migration 0008 — assignments_dedup_key', () => {
  it('rejects duplicate (env, conv, agent, assigned_at) with 23505', async () => {
    const assignedAt = '2026-04-15T13:00:00Z';
    const insert = `
      INSERT INTO core.conversation_assignments
        (environment, conversation_id, agent_id, assigned_at)
      VALUES ('test', $1, 42, $2)
    `;
    await db.pool.query(insert, [conversationId, assignedAt]);
    await expect(db.pool.query(insert, [conversationId, assignedAt])).rejects.toMatchObject({
      code: '23505',
      constraint: 'assignments_dedup_key',
    });
  });
});

describe('migration 0010 — hints_dedup_key', () => {
  it('rejects duplicate hint with same ruleset_hash', async () => {
    const messageId = '00000000-0000-0000-0000-000000000aaa';
    const insert = `
      INSERT INTO analytics.linguistic_hints
        (environment, conversation_id, message_id, hint_type, pattern_id,
         source, extractor_version, ruleset_hash)
      VALUES ('test', $1, $2, 'price_complaint', 'rx_price_v1',
              'regex_v1', 'enricher@1.0.0', 'hash_abc')
    `;
    await db.pool.query(insert, [conversationId, messageId]);
    await expect(db.pool.query(insert, [conversationId, messageId])).rejects.toMatchObject({
      code: '23505',
      constraint: 'hints_dedup_key',
    });
  });

  it('different ruleset_hash for the same hint is allowed (auditability)', async () => {
    const messageId = '00000000-0000-0000-0000-000000000bbb';
    const insert = `
      INSERT INTO analytics.linguistic_hints
        (environment, conversation_id, message_id, hint_type, pattern_id,
         source, extractor_version, ruleset_hash)
      VALUES ('test', $1, $2, 'price_complaint', 'rx_price_v1',
              'regex_v1', 'enricher@1.0.0', $3)
    `;
    await db.pool.query(insert, [conversationId, messageId, 'hash_v1']);
    await expect(
      db.pool.query(insert, [conversationId, messageId, 'hash_v2']),
    ).resolves.toMatchObject({ rowCount: 1 });
  });
});
