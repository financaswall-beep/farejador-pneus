import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres';
import { loadStaleTriggerCheck } from '../../src/shared/repositories/ops-atendente.repository';
import { isStaleTrigger } from '../../src/atendente-v2/stale-trigger';

let db: IntegrationDb;

beforeAll(async () => {
  db = await startPostgres();
});

afterAll(async () => {
  if (db) await stopPostgres(db);
});

async function newConversation(): Promise<string> {
  const r = await db.pool.query<{ id: string }>(
    `INSERT INTO core.conversations
       (environment, chatwoot_conversation_id, chatwoot_account_id, current_status, started_at)
     VALUES ('test', $1, 1, 'open', now())
     RETURNING id`,
    [Math.floor(Math.random() * 1_000_000_000)],
  );
  return r.rows[0].id;
}

/** Insere uma mensagem com created_at controlado por offset (segundos atrás de agora). */
async function insertMessage(
  conversationId: string,
  opts: { senderType: 'contact' | 'user'; typeName: 'incoming' | 'outgoing'; secondsAgo: number },
): Promise<string> {
  const r = await db.pool.query<{ id: string }>(
    `INSERT INTO core.messages
       (environment, conversation_id, chatwoot_message_id, sender_type, message_type_name,
        is_private, content, sent_at, created_at)
     VALUES ('test', $1, $2, $3, $4, false, 'x', now(), now() - ($5 || ' seconds')::interval)
     RETURNING id`,
    [conversationId, Math.floor(Math.random() * 1_000_000_000), opts.senderType, opts.typeName, String(opts.secondsAgo)],
  );
  return r.rows[0].id;
}

describe('loadStaleTriggerCheck + isStaleTrigger (trava anti-requentado)', () => {
  it('REQUENTADO: resposta nossa DEPOIS do gatilho → obsoleto', async () => {
    const conv = await newConversation();
    const trigger = await insertMessage(conv, { senderType: 'contact', typeName: 'incoming', secondsAgo: 30 });
    await insertMessage(conv, { senderType: 'user', typeName: 'outgoing', secondsAgo: 10 }); // resposta depois

    const check = await loadStaleTriggerCheck(db.pool as never, 'test', conv, trigger);
    expect(check.triggerCreatedAt).not.toBeNull();
    expect(check.latestOutgoingAt).not.toBeNull();
    expect(isStaleTrigger(check.triggerCreatedAt, check.latestOutgoingAt)).toBe(true);
  });

  it('NOVO: nenhuma resposta depois do gatilho → responde', async () => {
    const conv = await newConversation();
    await insertMessage(conv, { senderType: 'user', typeName: 'outgoing', secondsAgo: 30 }); // resposta ANTES
    const trigger = await insertMessage(conv, { senderType: 'contact', typeName: 'incoming', secondsAgo: 10 });

    const check = await loadStaleTriggerCheck(db.pool as never, 'test', conv, trigger);
    expect(isStaleTrigger(check.triggerCreatedAt, check.latestOutgoingAt)).toBe(false);
  });

  it('conversa sem nenhuma resposta nossa → responde (latestOutgoing nulo)', async () => {
    const conv = await newConversation();
    const trigger = await insertMessage(conv, { senderType: 'contact', typeName: 'incoming', secondsAgo: 5 });

    const check = await loadStaleTriggerCheck(db.pool as never, 'test', conv, trigger);
    expect(check.latestOutgoingAt).toBeNull();
    expect(isStaleTrigger(check.triggerCreatedAt, check.latestOutgoingAt)).toBe(false);
  });
});
