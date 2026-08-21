import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('quadro operacional de Clientes', () => {
  let db: IntegrationDb;
  let conversationId: string;
  let updateBoard: typeof import('../../src/admin/painel/customer-lead-board.js').updateCustomerLeadBoard;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV:'test',FAREJADOR_ENV:'test',DATABASE_URL:'postgres://test',
      CHATWOOT_HMAC_SECRET:'test-secret',ADMIN_AUTH_TOKEN:'emergency-token',
    });
    db = await startPostgres();
    process.env.DATABASE_URL = db.connectionString;
    vi.resetModules();
    ({ updateCustomerLeadBoard:updateBoard } =
      await import('../../src/admin/painel/customer-lead-board.js'));
    const contact = await db.pool.query<{ id:string }>(
      `INSERT INTO core.contacts(environment,chatwoot_contact_id,name)
       VALUES('test',996001,'Lead Kanban') RETURNING id`);
    conversationId = (await db.pool.query<{ id:string }>(
      `INSERT INTO core.conversations
         (environment,chatwoot_conversation_id,chatwoot_account_id,contact_id,current_status,started_at)
       VALUES('test',996001,1,$1,'open',now()) RETURNING id`,[contact.rows[0]!.id])).rows[0]!.id;
  },180_000);

  afterAll(async () => { if (db) await stopPostgres(db); });

  it('move, arquiva e restaura sem apagar conversa, mensagens ou contato', async () => {
    const moveKey = randomUUID();
    const moved = await updateBoard({
      environment:'test',conversationId,action:'move',lane:'orcamento',expectedVersion:0,
      actor:'Dono teste',idempotencyKey:moveKey,
    },db.pool);
    expect(moved).toMatchObject({ manual_lane:'orcamento',archived:false,version:1 });

    const replay = await updateBoard({
      environment:'test',conversationId,action:'move',lane:'orcamento',expectedVersion:0,
      actor:'Dono teste',idempotencyKey:moveKey,
    },db.pool);
    expect(replay).toMatchObject({ manual_lane:'orcamento',version:1,replayed:true });

    await expect(updateBoard({
      environment:'test',conversationId,action:'move',lane:'perdido',expectedVersion:0,
      actor:'Dono teste',idempotencyKey:randomUUID(),
    },db.pool)).rejects.toThrow('lead_version_conflict');

    const archived = await updateBoard({
      environment:'test',conversationId,action:'archive',expectedVersion:1,
      actor:'Dono teste',reason:'Sem retorno há mais de 90 dias',idempotencyKey:randomUUID(),
    },db.pool);
    expect(archived).toMatchObject({ manual_lane:'orcamento',archived:true,version:2 });

    const restored = await updateBoard({
      environment:'test',conversationId,action:'restore',expectedVersion:2,
      actor:'Dono teste',idempotencyKey:randomUUID(),
    },db.pool);
    expect(restored).toMatchObject({ manual_lane:'orcamento',archived:false,version:3 });

    const truth = await db.pool.query<{ conversations:string;contacts:string;audits:string }>(
      `SELECT
        (SELECT count(*)::text FROM core.conversations WHERE id=$1) conversations,
        (SELECT count(*)::text FROM core.contacts c JOIN core.conversations cv ON cv.contact_id=c.id WHERE cv.id=$1) contacts,
        (SELECT count(*)::text FROM audit.events WHERE domain='customer_lead_board' AND entity_id=$1) audits`,
      [conversationId]);
    expect(truth.rows[0]).toEqual({ conversations:'1',contacts:'1',audits:'3' });
  });

  it('banco impede mistura de ambiente', async () => {
    await expect(db.pool.query(
      `INSERT INTO ops.customer_lead_board_state(environment,conversation_id,updated_by)
       VALUES('prod',$1,'intruso')`,[conversationId],
    )).rejects.toThrow(/customer_lead_conversation_not_found/);
  });
});
