import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

// Prova REAL no banco da validade do pino (LOCATION_FRESHNESS_HOURS): o furo de
// 2026-07-16 foi o bot cravar "21 km" com um pino de 11 dias atrás na mesma thread.
// Com a janela, pino velho vira null e o bot pede a localização de novo.
// Import dinâmico (padrão da casa) porque customer-location puxa env via location-freshness.

describe('getLatestCustomerLocation — validade do pino no banco real', () => {
  let db: IntegrationDb;
  let getLatestCustomerLocation: typeof import('../../src/atendente-v2/customer-location.js').getLatestCustomerLocation;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
      CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'emergency-token',
    });
    db = await startPostgres();
    ({ getLatestCustomerLocation } = await import('../../src/atendente-v2/customer-location.js'));
  }, 120_000);
  afterAll(async () => { if (db) await stopPostgres(db); });

  async function newConversation(): Promise<string> {
    const r = await db.pool.query<{ id: string }>(
      `INSERT INTO core.conversations
         (environment, chatwoot_conversation_id, chatwoot_account_id, current_status, started_at)
       VALUES ('test', $1, 1, 'open', now()) RETURNING id`,
      [Math.floor(Math.random() * 1_000_000_000)],
    );
    return r.rows[0]!.id;
  }

  /** Insere um PINO (message_attachment file_type='location') com idade controlada. */
  async function insertPin(conversationId: string, opts: { lat: number; lng: number; hoursAgo: number }): Promise<void> {
    const msg = await db.pool.query<{ id: string }>(
      `INSERT INTO core.messages
         (environment, conversation_id, chatwoot_conversation_id, chatwoot_message_id,
          sender_type, message_type, is_private, content, sent_at, created_at)
       VALUES ('test', $1, (SELECT chatwoot_conversation_id FROM core.conversations WHERE id=$1),
               $2, 'contact', 0, false, '[location]',
               now() - ($3 || ' hours')::interval, now() - ($3 || ' hours')::interval)
       RETURNING id`,
      [conversationId, Math.floor(Math.random() * 1_000_000_000), String(opts.hoursAgo)],
    );
    await db.pool.query(
      `INSERT INTO core.message_attachments
         (environment, chatwoot_attachment_id, message_id, conversation_id, file_type,
          coordinates_lat, coordinates_lng, created_at)
       VALUES ('test', $1, $2, $3, 'location', $4, $5, now() - ($6 || ' hours')::interval)`,
      [Math.floor(Math.random() * 1_000_000_000), msg.rows[0]!.id, conversationId,
       opts.lat, opts.lng, String(opts.hoursAgo)],
    );
  }

  it('pino de 11 dias + janela 6h → null (o bot vai pedir a localização de novo)', async () => {
    const conv = await newConversation();
    await insertPin(conv, { lat: -22.9, lng: -43.1, hoursAgo: 24 * 11 });
    expect(await getLatestCustomerLocation(db.pool as never, 'test', conv, 6)).toBeNull();
  });

  it('MESMO pino de 11 dias SEM janela (0) → ainda é usado (o furo de 2026-07-16)', async () => {
    const conv = await newConversation();
    await insertPin(conv, { lat: -22.9, lng: -43.1, hoursAgo: 24 * 11 });
    expect(await getLatestCustomerLocation(db.pool as never, 'test', conv, 0)).toEqual({ lat: -22.9, lng: -43.1 });
  });

  it('pino velho (11 dias) + pino recente (1h) + janela 6h → usa o RECENTE', async () => {
    const conv = await newConversation();
    await insertPin(conv, { lat: -22.9, lng: -43.1, hoursAgo: 24 * 11 });  // onde estava faz tempo
    await insertPin(conv, { lat: -22.98, lng: -43.19, hoursAgo: 1 });      // onde está agora
    expect(await getLatestCustomerLocation(db.pool as never, 'test', conv, 6)).toEqual({ lat: -22.98, lng: -43.19 });
  });

  it('pino de 2h + janela 6h → usa (está dentro da janela)', async () => {
    const conv = await newConversation();
    await insertPin(conv, { lat: -22.98, lng: -43.19, hoursAgo: 2 });
    expect(await getLatestCustomerLocation(db.pool as never, 'test', conv, 6)).toEqual({ lat: -22.98, lng: -43.19 });
  });
});
