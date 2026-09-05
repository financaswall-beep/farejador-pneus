import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres';
import { functionItem, jsonResponse, reasoningItem, responseBody, textItem } from '../unit/atendente/responses-fixtures';
import type { AgentV2JobInput } from '../../src/atendente-v2/types';

let db: IntegrationDb;
let appPool: Pool;
let runAgentV2: typeof import('../../src/atendente-v2/agent').runAgentV2;
let markFailed: typeof import('../../src/shared/repositories/ops-atendente.repository').markAtendenteJobFailed;
let job: AgentV2JobInput;
let nativeId = 71000;
const fetcher = vi.fn<typeof fetch>();

beforeAll(async () => {
  // Sem fallback para .env ou bancos remotos: só o container descartável.
  db = await startPostgres();
  expect(new URL(db.connectionString).hostname).toBe('127.0.0.1');
  Object.assign(process.env, { NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: db.connectionString,
    DATABASE_SSL: 'false', CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'test-token',
    OPENAI_API_KEY: 'fixture-only', OPENAI_MODEL: 'gpt-5.6-sol', BOT_OUTBOX: 'true',
    AGENT_V2_WORKER_ENABLED: 'false', ROUTING_GEO: 'false', SATISFACTION_SURVEY: 'false', PHOTO_REQUESTS: 'false',
  });
  ({ runAgentV2 } = await import('../../src/atendente-v2/agent'));
  ({ pool: appPool } = await import('../../src/persistence/db'));
  ({ markAtendenteJobFailed: markFailed } = await import('../../src/shared/repositories/ops-atendente.repository'));
});
afterAll(async () => { if (appPool) await appPool.end(); if (db) await stopPostgres(db); });
afterEach(() => { vi.unstubAllGlobals(); });

async function createJob(): Promise<AgentV2JobInput> {
  const conversation = await db.pool.query(`INSERT INTO core.conversations
    (environment,chatwoot_conversation_id,chatwoot_account_id,current_status,started_at)
    VALUES ('test',$1,2,'open',now()) RETURNING id`, [++nativeId]);
  const conversationId = conversation.rows[0].id as string;
  const message = await db.pool.query(`INSERT INTO core.messages
    (environment,conversation_id,chatwoot_conversation_id,chatwoot_message_id,sender_type,message_type,is_private,content,sent_at)
    VALUES ('test',$1,$2,$3,'contact',0,false,'Qual é o horário?',now()) RETURNING id`,
  [conversationId, nativeId, ++nativeId]);
  const triggerMessageId = message.rows[0].id as string;
  // O worker real chama runAgentV2 somente depois de reservar o job em processing.
  const queued = await db.pool.query(`INSERT INTO ops.atendente_jobs(environment,conversation_id,trigger_message_id,status,attempts)
    VALUES ('test',$1,$2,'processing',1) ON CONFLICT (environment,trigger_message_id)
    DO UPDATE SET status='processing',attempts=1 RETURNING id`,
  [conversationId, triggerMessageId]);
  return { conversationId, triggerMessageId, jobId: queued.rows[0].id as string, environment: 'test' };
}
beforeEach(async () => {
  job = await createJob(); fetcher.mockReset();
  // Qualquer fetch é interceptado; nenhum worker de envio é iniciado.
  vi.stubGlobal('fetch', fetcher);
});
async function queuedFor(target: AgentV2JobInput) {
  return (await db.pool.query(`SELECT body,status FROM ops.outbound_messages WHERE conversation_id=$1`, [target.conversationId])).rows;
}

describe('Responses → ferramenta real → outbox no PostgreSQL isolado', () => {
  it('grava rascunho, ações e tokens sem reasoning; não chama Chatwoot nem modifica mensagens', async () => {
    const answer = 'Vou confirmar o horário com a equipe.';
    fetcher.mockResolvedValueOnce(jsonResponse(responseBody([reasoningItem,
      functionItem('policy_call', 'buscar_politica', '{"policy_keys":["fixture_inexistente"]}')])))
      .mockResolvedValueOnce(jsonResponse(responseBody([textItem(answer)])));
    await runAgentV2(job);
    const continuation = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
    expect(continuation.input).toContainEqual(reasoningItem);
    expect(continuation.input).toContainEqual({ type: 'function_call_output', call_id: 'policy_call', output: '{"politicas":[]}' });
    const saved = (await db.pool.query(`SELECT status,actions,llm_input_tokens,llm_output_tokens FROM agent.turns
      WHERE conversation_id=$1`, [job.conversationId])).rows[0];
    expect(saved).toMatchObject({ status: 'generated', llm_input_tokens: 200, llm_output_tokens: 50 });
    expect(saved.actions).toHaveLength(2);
    expect(saved.actions[1]).toEqual({ role: 'tool', tool_call_id: 'policy_call', content: '{"politicas":[]}' });
    expect(JSON.stringify(saved)).not.toContain(reasoningItem.encrypted_content);
    expect(await queuedFor(job)).toEqual([{ body: answer, status: 'pending' }]);
    expect((await db.pool.query(`SELECT content FROM core.messages WHERE conversation_id=$1`, [job.conversationId])).rows)
      .toEqual([{ content: 'Qual é o horário?' }]);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(Array(2).fill('https://api.openai.com/v1/responses'));
  });
  it('uma mensagem humana durante a API pausa só aquela conversa, sem aviso ao cliente', async () => {
    const other = await createJob();
    fetcher.mockImplementationOnce(async () => {
      await db.pool.query(`INSERT INTO core.messages
        (environment,conversation_id,chatwoot_conversation_id,chatwoot_message_id,sender_type,message_type,is_private,content,sent_at)
        SELECT 'test',id,chatwoot_conversation_id,$2,'user',1,false,'Eu sigo com seu atendimento.',clock_timestamp()
        FROM core.conversations WHERE id=$1`, [job.conversationId, ++nativeId]);
      return jsonResponse(responseBody([reasoningItem, functionItem('write_call', 'criar_pedido')]));
    }).mockResolvedValueOnce(jsonResponse(responseBody()));
    await runAgentV2(job);
    expect(await queuedFor(job)).toEqual([]);
    expect((await db.pool.query(`SELECT mode FROM ops.conversation_bot_control WHERE conversation_id=$1`, [job.conversationId])).rows[0].mode).toBe('human');
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM agent.turns WHERE conversation_id=$1`, [job.conversationId])).rows[0].n).toBe(0);
    await runAgentV2(other);
    expect(await queuedFor(other)).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('resposta incompleta vai à revisão técnica sem enviar texto parcial nem repetir ferramentas', async () => {
    fetcher.mockResolvedValue(jsonResponse({ ...responseBody([functionItem('write_call', 'criar_pedido')]),
      status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }));
    const failure = await runAgentV2(job).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const client = await db.pool.connect();
    try { await markFailed(client, job.jobId, String(failure), true); } finally { client.release(); }
    expect((await db.pool.query(`SELECT status FROM ops.atendente_jobs WHERE id=$1`, [job.jobId])).rows[0].status).toBe('dead_letter');
    expect(await queuedFor(job)).toEqual([]); expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
