import { describe, expect, it } from 'vitest';
import { loadCurrent } from '../../../../src/atendente/state/agent-state.repository.js';

const conversationId = '00000000-0000-4000-8000-000000000001';
const contactId = '00000000-0000-4000-8000-000000000002';
const itemId = '00000000-0000-4000-8000-000000000010';
const baseTime = new Date('2026-04-29T12:00:00.000Z');

describe('loadCurrent', () => {
  it('popula derived_signals.stale_slots a partir dos slots persistidos', async () => {
    const client = {
      query: async (sql: string) => {
        if (sql.includes('FROM agent.session_current')) {
          return {
            rows: [
              {
                environment: 'test',
                conversation_id: conversationId,
                contact_id: contactId,
                status: 'active',
                current_skill: null,
                last_customer_message_id: null,
                last_agent_turn_id: null,
                version: '3',
                turn_index: 7,
                updated_at: baseTime,
                created_at: baseTime,
              },
            ],
          };
        }

        if (sql.includes('FROM agent.session_items')) {
          return {
            rows: [
              {
                id: itemId,
                status: 'aberto',
                is_active: true,
                created_at: baseTime,
                updated_at: baseTime,
              },
            ],
          };
        }

        if (sql.includes('FROM agent.session_slots')) {
          return {
            rows: [
              slotRow('item-slot-1', 'item', itemId, 'medida_pneu', '110/90-17', 'stale_strong'),
              slotRow('item-slot-2', 'item', itemId, 'posicao_pneu', 'traseiro', 'fresh'),
              slotRow('global-slot-1', 'global', null, 'bairro', 'Meier', 'stale'),
            ],
          };
        }

        if (sql.includes('FROM agent.session_events')) return { rows: [] };
        if (sql.includes('FROM agent.pending_confirmations')) return { rows: [] };
        if (sql.includes('FROM agent.cart_current')) return { rows: [] };
        if (sql.includes('FROM agent.order_drafts')) return { rows: [] };

        throw new Error(`unexpected_query:${sql}`);
      },
    };

    const state = await loadCurrent(client as never, 'test', conversationId);

    expect(state?.derived_signals.stale_slots).toEqual(['medida_pneu', 'bairro']);
    expect(state?.items[0]?.slots.medida_pneu?.stale).toBe('stale_strong');
    expect(state?.global_slots.bairro?.stale).toBe('stale');
  });
});

function slotRow(
  id: string,
  scope: 'global' | 'item',
  itemIdValue: string | null,
  slotKey: string,
  value: unknown,
  stale: 'fresh' | 'stale' | 'stale_strong',
) {
  return {
    id,
    scope,
    item_id: itemIdValue,
    slot_key: slotKey,
    value_json: value,
    source: 'observed',
    confidence: '1',
    stale,
    requires_confirmation: stale !== 'fresh',
    evidence_text: null,
    set_by_message_id: null,
    set_by_skill: null,
    previous_value_json: null,
    set_at: baseTime,
  };
}
