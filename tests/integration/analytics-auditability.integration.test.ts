import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres';

let db: IntegrationDb;
let conversationId: string;
let messageId: string;

beforeAll(async () => {
  db = await startPostgres();
});

afterAll(async () => {
  if (db) await stopPostgres(db);
});

beforeEach(async () => {
  const conversation = await db.pool.query<{ id: string }>(
    `INSERT INTO core.conversations
       (environment, chatwoot_conversation_id, chatwoot_account_id,
        current_status, started_at)
     VALUES ('test', $1, 1, 'open', '2026-04-15T10:00:00Z')
     RETURNING id`,
    [Math.floor(Math.random() * 1_000_000_000)],
  );
  conversationId = conversation.rows[0].id;

  const message = await db.pool.query<{ id: string }>(
    `INSERT INTO core.messages
       (environment, conversation_id, chatwoot_conversation_id, chatwoot_message_id,
        sender_type, message_type, content, sent_at)
     VALUES ('test', $1,
             (SELECT chatwoot_conversation_id FROM core.conversations WHERE id=$1),
             $2, 'contact', 0, 'mensagem de teste', '2026-04-15T10:01:00Z')
     RETURNING id`,
    [conversationId, Math.floor(Math.random() * 1_000_000_000)],
  );
  messageId = message.rows[0].id;
});

describe('migration 0011 - extensible linguistic_hints.hint_type', () => {
  it('allows segment-specific hint_type values after dropping the closed CHECK', async () => {
    await expect(
      db.pool.query(
        `INSERT INTO analytics.linguistic_hints
           (environment, conversation_id, message_id, hint_type, pattern_id,
            source, extractor_version, ruleset_hash)
         VALUES ('test', $1, $2, 'segment_specific_hint_for_ci', 'rule_ci',
                 'deterministic_rules_v1', 'ci_rules_v1', 'hash_ci')`,
        [conversationId, messageId],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it('keeps hints_dedup_key active after relaxing hint_type', async () => {
    const insert = `
      INSERT INTO analytics.linguistic_hints
        (environment, conversation_id, message_id, hint_type, pattern_id,
         source, extractor_version, ruleset_hash)
      VALUES ('test', $1, $2, 'price_complaint', 'rule_ci',
              'deterministic_rules_v1', 'ci_rules_v1', 'hash_same')
    `;

    await db.pool.query(insert, [conversationId, messageId]);
    await expect(db.pool.query(insert, [conversationId, messageId])).rejects.toMatchObject({
      code: '23505',
      constraint: 'hints_dedup_key',
    });
  });
});

describe('migration 0012 - classification ruleset auditability', () => {
  it('rejects duplicate classification with same ruleset_hash', async () => {
    const insert = `
      INSERT INTO analytics.conversation_classifications
        (environment, conversation_id, dimension, value, truth_type,
         source, confidence_level, extractor_version, ruleset_hash)
      VALUES ('test', $1, 'urgency', 'high', 'inferred',
              'deterministic_classification_v1', 0.80, 'f2a_classification_v1', 'hash_same')
    `;

    await db.pool.query(insert, [conversationId]);
    await expect(db.pool.query(insert, [conversationId])).rejects.toMatchObject({
      code: '23505',
      constraint: 'classifications_dedup_key',
    });
  });

  it('allows same classification with different ruleset_hash for audit history', async () => {
    const insert = `
      INSERT INTO analytics.conversation_classifications
        (environment, conversation_id, dimension, value, truth_type,
         source, confidence_level, extractor_version, ruleset_hash)
      VALUES ('test', $1, 'urgency', 'high', 'inferred',
              'deterministic_classification_v1', 0.80, 'f2a_classification_v1', $2)
    `;

    await db.pool.query(insert, [conversationId, 'hash_v1']);
    await expect(db.pool.query(insert, [conversationId, 'hash_v2'])).resolves.toMatchObject({
      rowCount: 1,
    });
  });
});
