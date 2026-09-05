import type { Pool } from 'pg';
import { pool } from '../../persistence/db.js';
import { env } from '../../shared/config/env.js';
import { cancelConversationBotQueue, lockBotConversation, syncHumanIntervention } from '../../atendente-v2/conversation-control.js';

export async function getBotConversationControl(conversationId: string, db: Pool = pool) {
  const result = await db.query(`SELECT c.id AS conversation_id,COALESCE(b.mode,'auto') AS mode,
      COALESCE(b.version,0) AS version,b.updated_at,b.updated_by
    FROM core.conversations c LEFT JOIN ops.conversation_bot_control b
      ON b.environment=c.environment AND b.conversation_id=c.id
    WHERE c.environment=$1 AND c.id=$2 AND c.deleted_at IS NULL`, [env.FAREJADOR_ENV,conversationId]);
  if (!result.rows[0]) throw new Error('bot_conversation_not_found');
  return result.rows[0];
}

export async function listHumanControlledConversations(db: Pool = pool) {
  const result = await db.query(`SELECT b.conversation_id,b.mode,b.version,b.updated_at,
      c.chatwoot_conversation_id,ct.name AS contact_name
    FROM ops.conversation_bot_control b
    JOIN core.conversations c ON c.id=b.conversation_id AND c.environment=b.environment
    LEFT JOIN core.contacts ct ON ct.id=c.contact_id AND ct.environment=c.environment AND ct.deleted_at IS NULL
    WHERE b.environment=$1 AND b.mode='human' AND c.deleted_at IS NULL
    ORDER BY b.updated_at DESC LIMIT 200`, [env.FAREJADOR_ENV]);
  return result.rows;
}

export async function changeBotConversationControl(input: {
  conversationId: string; action: 'takeover' | 'resume'; expectedVersion: number; actor: string;
}, db: Pool = pool) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await lockBotConversation(client,env.FAREJADOR_ENV,input.conversationId);
    const state = await syncHumanIntervention(client,env.FAREJADOR_ENV,input.conversationId);
    if (state.version!==input.expectedVersion) {
      // Preserva eventual intervenção recém-observada mesmo quando a tela está desatualizada.
      await client.query('COMMIT');
      throw new Error('bot_control_conflict');
    }
    const mode = input.action==='takeover' ? 'human' : 'auto';
    if (state.mode===mode) { await client.query('COMMIT'); return { mode,version:state.version }; }
    const changed = await client.query(`UPDATE ops.conversation_bot_control SET mode=$3,version=version+1,
        resumed_at=CASE WHEN $3='auto' THEN clock_timestamp() ELSE resumed_at END,
        updated_by=$4,updated_at=now()
      WHERE environment=$1 AND conversation_id=$2 RETURNING mode,version`,
    [env.FAREJADOR_ENV,input.conversationId,mode,input.actor]);
    // Cancela também na retomada: ela libera apenas mensagens NOVAS do cliente.
    await cancelConversationBotQueue(client,env.FAREJADOR_ENV,input.conversationId);
    await client.query(`INSERT INTO ops.conversation_bot_control_events
      (environment,conversation_id,version,action,actor) VALUES ($1,$2,$3,$4,$5)`,
    [env.FAREJADOR_ENV,input.conversationId,changed.rows[0].version,input.action,input.actor]);
    await client.query('COMMIT');
    return changed.rows[0];
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
