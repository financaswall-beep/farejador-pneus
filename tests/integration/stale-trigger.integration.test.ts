import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres';
import { loadStaleTriggerCheck } from '../../src/shared/repositories/ops-atendente.repository';
import { isStaleTrigger } from '../../src/atendente-v2/stale-trigger';

let db: IntegrationDb;

beforeAll(async () => { db = await startPostgres(); });
afterAll(async () => { if (db) await stopPostgres(db); });

async function newConversation(): Promise<string> {
  const result = await db.pool.query<{ id: string }>(
    `INSERT INTO core.conversations
       (environment, chatwoot_conversation_id, chatwoot_account_id, current_status, started_at)
     VALUES ('test', $1, 1, 'open', now()) RETURNING id`,
    [Math.floor(Math.random() * 1_000_000_000)],
  );
  return result.rows[0].id;
}

async function insertMessage(
  conversationId: string,
  opts: { senderType: 'contact' | 'user'; typeName: 'incoming' | 'outgoing'; secondsAgo: number },
): Promise<string> {
  const result = await db.pool.query<{ id: string }>(
    `INSERT INTO core.messages
       (environment, conversation_id, chatwoot_conversation_id, chatwoot_message_id,
        sender_type, message_type, is_private, content, sent_at, created_at)
     VALUES ('test', $1,
             (SELECT chatwoot_conversation_id FROM core.conversations WHERE id=$1),
             $2, $3, $4, false, 'x', now(), now() - ($5 || ' seconds')::interval)
     RETURNING id`,
    [conversationId, Math.floor(Math.random() * 1_000_000_000), opts.senderType,
     opts.typeName === 'incoming' ? 0 : 1, String(opts.secondsAgo)],
  );
  return result.rows[0].id;
}

describe('loadStaleTriggerCheck + isStaleTrigger', () => {
  it('descarta o gatilho que ja possui turno entregue', async () => {
    const conversationId = await newConversation();
    const triggerId = await insertMessage(conversationId, {
      senderType: 'contact', typeName: 'incoming', secondsAgo: 30,
    });
    await db.pool.query(
      `INSERT INTO agent.turns
         (environment,conversation_id,trigger_message_id,agent_version,context_hash,status)
       VALUES ('test',$1,$2,'integration-test','hash','delivered')`,
      [conversationId, triggerId],
    );

    const check = await loadStaleTriggerCheck(db.pool as never, 'test', conversationId, triggerId);
    expect(check.thisTriggerAt).not.toBeNull();
    expect(check.lastAnsweredTriggerAt).not.toBeNull();
    expect(isStaleTrigger(check.thisTriggerAt, check.lastAnsweredTriggerAt)).toBe(true);
  });

  it('nao confunde uma mensagem de saida sem turno entregue com resposta ao gatilho', async () => {
    const conversationId = await newConversation();
    await insertMessage(conversationId, { senderType: 'user', typeName: 'outgoing', secondsAgo: 30 });
    const triggerId = await insertMessage(conversationId, {
      senderType: 'contact', typeName: 'incoming', secondsAgo: 10,
    });

    const check = await loadStaleTriggerCheck(db.pool as never, 'test', conversationId, triggerId);
    expect(isStaleTrigger(check.thisTriggerAt, check.lastAnsweredTriggerAt)).toBe(false);
  });

  it('responde quando a conversa nunca teve turno entregue', async () => {
    const conversationId = await newConversation();
    const triggerId = await insertMessage(conversationId, {
      senderType: 'contact', typeName: 'incoming', secondsAgo: 5,
    });

    const check = await loadStaleTriggerCheck(db.pool as never, 'test', conversationId, triggerId);
    expect(check.lastAnsweredTriggerAt).toBeNull();
    expect(isStaleTrigger(check.thisTriggerAt, check.lastAnsweredTriggerAt)).toBe(false);
  });
});
