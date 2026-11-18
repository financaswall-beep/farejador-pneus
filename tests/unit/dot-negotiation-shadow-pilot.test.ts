import type { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setDotEventsAvailability } from '../../src/admin/dot/events/availability.js';
import { setShadowPilotSchemaReady, shadowPilotEnabled, shadowPilotIds } from '../../src/admin/dot/events/negotiation-shadow-pilot.js';
import { readSnapshot } from '../../src/admin/dot/events/snapshots.js';

const config = vi.hoisted(() => ({
  DOT_EVENTS_ENABLED: true,
  DOT_NEGOTIATION_SHADOW_CONVERSATIONS: '',
  DOT_EVENTS_WAIT_MINUTES: 10,
  FAREJADOR_ENV: 'test',
  CHATWOOT_ACCOUNT_ID: 17,
  CHATWOOT_API_BASE_URL: 'https://chat.example.test',
}));
vi.mock('../../src/shared/config/env.js', () => ({ env: config }));
vi.mock('../../src/persistence/db.js', () => ({ pool: {} }));

const selected = 'abcdef01-0000-4000-8000-000000000001';
const outside = 'abcdef02-0000-4000-8000-000000000002';
const now = new Date('2026-11-18T12:00:00Z');

function conversationSnapshot(id: string) {
  const client = {
    async query(sql: string, params?: unknown[]) {
      if (sql.includes('FROM core.conversations')) {
        expect(params).toEqual(['test', id, 17]);
        return { rows: [{ id, chatwoot_conversation_id: 123, current_status: 'open',
          resolved_at: null, waiting_since: null, last_activity_at: now, message_id: 'synthetic',
          message_type: 1, sent_at: now, last_event_at: now }] };
      }
      if (/^(BEGIN|COMMIT|ROLLBACK)|FROM network\.dot_event_settings/.test(sql)) return { rows: [] };
      throw new Error(`Consulta inesperada no teste de snapshot: ${sql}`);
    },
    release: vi.fn(),
  };
  const db = { connect: async () => client } as unknown as Pool;
  return readSnapshot('conversation', id, db, now);
}

beforeEach(() => {
  config.DOT_EVENTS_ENABLED = true;
  config.DOT_NEGOTIATION_SHADOW_CONVERSATIONS = '';
  setDotEventsAvailability(null);
  setShadowPilotSchemaReady(true);
});

describe('piloto de negociação em sombra do Dot', () => {
  it.each(['', '   ', `${selected},invalido`, '*'])('desativa a lista inteira para %j', (input) => {
    config.DOT_NEGOTIATION_SHADOW_CONVERSATIONS = input;
    expect(shadowPilotIds()).toEqual([]);
    expect(shadowPilotEnabled()).toBe(false);
  });

  it('normaliza espaços e caixa dos UUIDs e remove duplicatas', () => {
    config.DOT_NEGOTIATION_SHADOW_CONVERSATIONS = ` ${selected.toUpperCase()}, ${outside}, ${selected} `;
    expect([...shadowPilotIds()].sort()).toEqual([selected, outside]);
    expect(shadowPilotEnabled()).toBe(true);
  });

  it('aceita 50 IDs e desativa o piloto inteiro com 51', () => {
    const ids = Array.from({ length: 51 }, (_, i) => `ab000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    config.DOT_NEGOTIATION_SHADOW_CONVERSATIONS = ids.slice(0, 50).join(',');
    expect([...shadowPilotIds()].sort()).toEqual(ids.slice(0, 50));
    expect(shadowPilotEnabled()).toBe(true);
    config.DOT_NEGOTIATION_SHADOW_CONVERSATIONS = ids.join(',');
    expect(shadowPilotIds()).toEqual([]);
    expect(shadowPilotEnabled()).toBe(false);
  });

  it('acrescenta somente o marcador booleano ao snapshot elegível com eventos ligados', async () => {
    config.DOT_NEGOTIATION_SHADOW_CONVERSATIONS = `${outside}, ${selected.toUpperCase()}`;
    config.DOT_EVENTS_ENABLED = false;
    expect(shadowPilotEnabled()).toBe(false);
    const baseline = await conversationSnapshot(selected);
    expect(baseline?.data).toMatchObject({ entity_id: selected });
    expect(baseline!.data).not.toHaveProperty('sombra_negociacao');

    config.DOT_EVENTS_ENABLED = true;
    const marked = await conversationSnapshot(selected);
    expect(marked?.data).toEqual({ ...baseline!.data, sombra_negociacao: true });
  });

  it.each([selected, `${outside},invalido`, ''])('omite o marcador se a conversa não for elegível (%j)', async (input) => {
    config.DOT_NEGOTIATION_SHADOW_CONVERSATIONS = input;
    const snapshot = await conversationSnapshot(outside);
    expect(snapshot?.data).toMatchObject({ entity_id: outside });
    expect(snapshot!.data).not.toHaveProperty('sombra_negociacao');
  });

  it('preserva o evento comum, sem o marcador, se o schema do piloto estiver indisponível', async () => {
    config.DOT_NEGOTIATION_SHADOW_CONVERSATIONS = selected;
    setShadowPilotSchemaReady(false);
    expect(shadowPilotEnabled()).toBe(true);
    const snapshot = await conversationSnapshot(selected);
    expect(snapshot?.data).toMatchObject({ entity_id: selected });
    expect(snapshot!.data).not.toHaveProperty('sombra_negociacao');
  });
});
