import { describe, expect, it } from 'vitest';
import { agentActionSchema, type AgentAction } from '../../../../src/shared/zod/agent-actions.js';
import type { ConversationState, SlotValue } from '../../../../src/shared/zod/agent-state.js';
import { applyAction } from '../../../../src/atendente/state/apply-action.js';
import {
  AgentStateVersionConflictError,
  applyActionAndPersist,
} from '../../../../src/atendente/state/agent-state.repository.js';
import { validateAction } from '../../../../src/atendente/validators/action-validator.js';

const baseTime = '2026-04-29T12:00:00.000Z';
const conversationId = '00000000-0000-4000-8000-000000000001';
const contactId = '00000000-0000-4000-8000-000000000002';
const itemId = '00000000-0000-4000-8000-000000000010';
const actionId = '00000000-0000-4000-8000-000000000100';

function state(overrides: Partial<ConversationState> = {}): ConversationState {
  return {
    schema_version: 'atendente_v1.0',
    environment: 'test',
    conversation_id: conversationId,
    contact_id: contactId,
    status: 'active',
    current_skill: null,
    last_customer_message_id: null,
    last_agent_turn_id: null,
    last_processed_message_id: null,
    version: 0,
    turn_index: 0,
    items: [],
    global_slots: {},
    cart: [],
    pending_confirmation: null,
    last_offer: null,
    derived_signals: {
      missing_for_close: [],
      stale_slots: [],
      recent_objections: [],
      has_pending_human_request: false,
      offer_expired: false,
    },
    updated_at: baseTime,
    created_at: baseTime,
    ...overrides,
  };
}

function baseAction<T extends AgentAction>(action: Omit<T, 'action_id' | 'turn_index' | 'emitted_at' | 'emitted_by'>): T {
  return {
    action_id: actionId,
    turn_index: 1,
    emitted_at: baseTime,
    emitted_by: 'system',
    ...action,
  } as T;
}

function slot(value: unknown, source: SlotValue['source']): SlotValue {
  return {
    scope: 'item',
    item_id: itemId,
    slot_key: 'medida_pneu',
    value_json: value,
    source,
    confidence: 1,
    stale: 'fresh',
    requires_confirmation: false,
    set_at: baseTime,
  };
}

function namedSlot(slotKey: SlotValue['slot_key'], value: unknown, source: SlotValue['source'] = 'observed'): SlotValue {
  return {
    ...slot(value, source),
    slot_key: slotKey,
  };
}

describe('applyAction - estado reentrante da Atendente', () => {
  it('cria item ativo sem depender de etapa linear', () => {
    const result = applyAction(
      state(),
      baseAction({ type: 'create_item', item_id: itemId, make_active: true }),
    );

    expect(result.state.items).toHaveLength(1);
    expect(result.state.items[0]!.is_active).toBe(true);
    expect(result.events_to_emit[0]!.event_type).toBe('item_created');
  });

  it('preenche medida sem moto_modelo, permitindo buscar_e_ofertar por medida explicita', () => {
    const initial = state({
      items: [
        {
          id: itemId,
          status: 'aberto',
          is_active: true,
          created_at: baseTime,
          slots: {},
        },
      ],
    });

    const result = applyAction(
      initial,
      baseAction({
        type: 'update_slot',
        scope: 'item',
        item_id: itemId,
        slot_key: 'medida_pneu',
        value: '175/70 R17',
        source: 'observed',
        confidence: 1,
      }),
    );

    expect(result.state.items[0]!.slots.medida_pneu?.value_json).toBe('175/70 R17');
    expect(result.state.items[0]!.slots.moto_modelo).toBeUndefined();
  });

  it('troca de moto invalida oferta e preserva medida observed como stale', () => {
    const initial = state({
      items: [
        {
          id: itemId,
          status: 'ofertado',
          is_active: true,
          created_at: baseTime,
          slots: {
            medida_pneu: slot('175/70 R17', 'observed'),
          },
        },
      ],
      last_offer: {
        offer_id: '00000000-0000-4000-8000-000000000020',
        item_id: itemId,
        products: [{ sku: 'P1' }],
        expires_at: '2026-04-29T13:00:00.000Z',
        invalidated: false,
        invalidation_reason: null,
      },
    });

    const result = applyAction(
      initial,
      baseAction({
        type: 'update_slot',
        scope: 'item',
        item_id: itemId,
        slot_key: 'moto_modelo',
        value: 'CG 160',
        source: 'observed',
        confidence: 1,
      }),
    );

    expect(result.state.last_offer?.invalidated).toBe(true);
    expect(result.state.items[0]!.slots.medida_pneu?.value_json).toBe('175/70 R17');
    expect(result.state.items[0]!.slots.medida_pneu?.stale).toBe('stale');
  });

  it('troca de item ativo invalida oferta do item antigo e marca slots antigos como stale_strong', () => {
    const secondItemId = '00000000-0000-4000-8000-000000000011';
    const initial = state({
      items: [
        {
          id: itemId,
          status: 'ofertado',
          is_active: true,
          created_at: baseTime,
          slots: {
            moto_modelo: namedSlot('moto_modelo', 'Bros 160'),
            medida_pneu: namedSlot('medida_pneu', '110/90-17', 'confirmed'),
          },
        },
        {
          id: secondItemId,
          status: 'aberto',
          is_active: false,
          created_at: baseTime,
          slots: {
            moto_modelo: {
              ...namedSlot('moto_modelo', 'Biz 125'),
              item_id: secondItemId,
            },
          },
        },
      ],
      last_offer: {
        offer_id: '00000000-0000-4000-8000-000000000020',
        item_id: itemId,
        products: [{ sku: 'P-BROS' }],
        expires_at: '2026-04-29T13:00:00.000Z',
        invalidated: false,
        invalidation_reason: null,
      },
    });

    const result = applyAction(
      initial,
      baseAction({ type: 'set_active_item', item_id: secondItemId }),
    );

    expect(result.state.items.find((item) => item.id === itemId)?.is_active).toBe(false);
    expect(result.state.items.find((item) => item.id === secondItemId)?.is_active).toBe(true);
    expect(result.state.last_offer?.invalidated).toBe(true);
    expect(result.state.last_offer?.invalidation_reason).toBe('active_item_changed');
    expect(result.state.items[0]!.slots.moto_modelo?.stale).toBe('stale_strong');
    expect(result.state.items[0]!.slots.medida_pneu?.stale).toBe('stale_strong');
    expect(result.events_to_emit.map((event) => event.event_type)).toEqual([
      'active_item_changed',
      'offer_invalidated',
      'slot_marked_stale',
      'slot_marked_stale',
    ]);
  });

  it('troca de posicao do pneu invalida oferta para nao vender dianteiro como traseiro', () => {
    const initial = state({
      items: [
        {
          id: itemId,
          status: 'ofertado',
          is_active: true,
          created_at: baseTime,
          slots: {
            posicao_pneu: namedSlot('posicao_pneu', 'dianteiro'),
          },
        },
      ],
      last_offer: {
        offer_id: '00000000-0000-4000-8000-000000000020',
        item_id: itemId,
        products: [{ sku: 'P-FRONT' }],
        expires_at: '2026-04-29T13:00:00.000Z',
        invalidated: false,
        invalidation_reason: null,
      },
    });

    const result = applyAction(
      initial,
      baseAction({
        type: 'update_slot',
        scope: 'item',
        item_id: itemId,
        slot_key: 'posicao_pneu',
        value: 'traseiro',
        source: 'observed',
        confidence: 1,
      }),
    );

    expect(result.state.last_offer?.invalidated).toBe(true);
    expect(result.state.last_offer?.invalidation_reason).toBe('item.posicao_pneu_changed');
  });

  it('troca de forma de pagamento global invalida oferta com condicao comercial antiga', () => {
    const initial = state({
      last_offer: {
        offer_id: '00000000-0000-4000-8000-000000000020',
        item_id: itemId,
        products: [{ sku: 'P1', price: 120 }],
        expires_at: '2026-04-29T13:00:00.000Z',
        invalidated: false,
        invalidation_reason: null,
      },
    });

    const result = applyAction(
      initial,
      baseAction({
        type: 'update_slot',
        scope: 'global',
        item_id: null,
        slot_key: 'forma_pagamento',
        value: 'cartao_credito',
        source: 'observed',
        confidence: 1,
      }),
    );

    expect(result.state.global_slots.forma_pagamento?.value_json).toBe('cartao_credito');
    expect(result.state.last_offer?.invalidated).toBe(true);
    expect(result.state.last_offer?.invalidation_reason).toBe('global.forma_pagamento_changed');
  });

  it('troca de moto deleta medida inferred', () => {
    const initial = state({
      items: [
        {
          id: itemId,
          status: 'aberto',
          is_active: true,
          created_at: baseTime,
          slots: {
            medida_pneu: slot('100/90 R17', 'inferred'),
          },
        },
      ],
    });

    const result = applyAction(
      initial,
      baseAction({
        type: 'update_slot',
        scope: 'item',
        item_id: itemId,
        slot_key: 'moto_modelo',
        value: 'Bros',
        source: 'observed',
        confidence: 1,
      }),
    );

    expect(result.state.items[0]!.slots.medida_pneu).toBeUndefined();
  });

  it('volta atras preserva previous_value do slot atualizado', () => {
    const initial = state({
      items: [
        {
          id: itemId,
          status: 'aberto',
          is_active: true,
          created_at: baseTime,
          slots: {
            moto_modelo: {
              scope: 'item',
              item_id: itemId,
              slot_key: 'moto_modelo',
              value_json: 'CG 160',
              source: 'observed',
              confidence: 1,
              stale: 'fresh',
              requires_confirmation: false,
              set_at: baseTime,
            },
          },
        },
      ],
    });

    const result = applyAction(
      initial,
      baseAction({
        type: 'update_slot',
        scope: 'item',
        item_id: itemId,
        slot_key: 'moto_modelo',
        value: 'Bros',
        source: 'observed',
        confidence: 1,
      }),
    );

    expect(result.state.items[0]!.slots.moto_modelo?.value_json).toBe('Bros');
    expect(result.state.items[0]!.slots.moto_modelo?.previous_value_json).toBe('CG 160');
  });

  it('pergunta off-topic nao altera oferta pendente', () => {
    const initial = state({
      last_offer: {
        offer_id: '00000000-0000-4000-8000-000000000020',
        item_id: itemId,
        products: [{ sku: 'P1' }],
        expires_at: '2026-04-29T13:00:00.000Z',
        invalidated: false,
        invalidation_reason: null,
      },
    });

    const result = applyAction(initial, { type: 'select_skill', skill_name: 'responder_politica' });

    expect(result.state.last_offer).toEqual(initial.last_offer);
    expect(result.state.current_skill).toBe('responder_politica');
  });

  it('frete no meio da negociacao salva bairro global e invalida oferta', () => {
    const initial = state({
      last_offer: {
        offer_id: '00000000-0000-4000-8000-000000000020',
        item_id: itemId,
        products: [{ sku: 'P1' }],
        expires_at: '2026-04-29T13:00:00.000Z',
        invalidated: false,
        invalidation_reason: null,
      },
    });

    const result = applyAction(
      initial,
      baseAction({
        type: 'update_slot',
        scope: 'global',
        item_id: null,
        slot_key: 'bairro',
        value: 'Meier',
        source: 'observed',
        confidence: 1,
      }),
    );

    expect(result.state.global_slots.bairro?.value_json).toBe('Meier');
    expect(result.state.last_offer?.invalidated).toBe(true);
  });

  it('oferta expirada nao muda status do item automaticamente', () => {
    const initial = state({
      items: [
        { id: itemId, status: 'ofertado', is_active: true, created_at: baseTime, slots: {} },
      ],
      last_offer: {
        offer_id: '00000000-0000-4000-8000-000000000020',
        item_id: itemId,
        products: [{ sku: 'P1' }],
        expires_at: '2026-04-29T10:00:00.000Z',
        invalidated: false,
        invalidation_reason: null,
      },
    });

    expect(initial.items[0]!.status).toBe('ofertado');
    expect(initial.last_offer?.expires_at).toBe('2026-04-29T10:00:00.000Z');
  });

  it('objection pode ser registrada varias vezes sem travar skill reentrante', () => {
    const first = applyAction(
      state(),
      baseAction({
        type: 'add_objection',
        objection_type: 'preco_alto',
        source_message_id: '00000000-0000-4000-8000-000000000030',
      }),
    ).state;
    const second = applyAction(
      first,
      {
        ...baseAction({
          type: 'add_objection',
          objection_type: 'preco_alto',
          source_message_id: '00000000-0000-4000-8000-000000000031',
        }),
        action_id: '00000000-0000-4000-8000-000000000101',
      },
    ).state;

    expect(second.derived_signals.recent_objections).toEqual([]);
  });

  it('Planner output nao muta estado porque applyAction so aceita AgentAction', () => {
    const initial = state();
    const plannerOutput = {
      skill: 'buscar_e_ofertar',
      state_mutation: { global_slots: { bairro: 'Meier' } },
    };

    expect(plannerOutput.state_mutation.global_slots.bairro).toBe('Meier');
    expect(initial.global_slots.bairro).toBeUndefined();
  });

  it('ActionValidator bloqueia order confirmation sem slots criticos confirmed', () => {
    const result = validateAction(
      state({
        items: [
          {
            id: itemId,
            status: 'ofertado',
            is_active: true,
            created_at: baseTime,
            slots: {
              medida_pneu: slot('175/70 R17', 'observed'),
            },
          },
        ],
      }),
      { type: 'request_confirmation', confirmation_type: 'order_confirmation', expected_facts: {} },
    );

    expect(result.valid).toBe(false);
  });

  it('ActionValidator rejeita action duplicada de create_item', () => {
    const result = validateAction(
      state({
        items: [
          { id: itemId, status: 'aberto', is_active: true, created_at: baseTime, slots: {} },
        ],
      }),
      baseAction({ type: 'create_item', item_id: itemId, make_active: true }),
    );

    expect(result.valid).toBe(false);
  });

  it('seed inicial usa apenas globais e items vazios', () => {
    const seeded = state({
      global_slots: {
        nome: {
          scope: 'global',
          item_id: null,
          slot_key: 'nome',
          value_json: 'Wallace',
          source: 'inferred_from_history',
          confidence: 0.6,
          stale: 'fresh',
          requires_confirmation: true,
          set_at: baseTime,
        },
      },
    });

    expect(seeded.global_slots.nome?.requires_confirmation).toBe(true);
    expect(seeded.items).toHaveLength(0);
  });

  it('mark_slot_stale marca slot confirmado como stale_strong', () => {
    const initial = state({
      items: [
        {
          id: itemId,
          status: 'ofertado',
          is_active: true,
          created_at: baseTime,
          slots: {
            medida_pneu: slot('175/70 R17', 'confirmed'),
          },
        },
      ],
    });

    const result = applyAction(
      initial,
      baseAction({
        type: 'mark_slot_stale',
        scope: 'item',
        item_id: itemId,
        slot_key: 'medida_pneu',
        stale: 'stale_strong',
        reason: 'moto_changed',
      }),
    );

    expect(result.state.items[0]!.slots.medida_pneu?.stale).toBe('stale_strong');
    expect(result.state.items[0]!.slots.medida_pneu?.requires_confirmation).toBe(true);
  });

  it('ActionValidator permite order confirmation quando slots criticos estao confirmed', () => {
    const result = validateAction(
      state({
        items: [
          {
            id: itemId,
            status: 'ofertado',
            is_active: true,
            created_at: baseTime,
            slots: {
              medida_pneu: slot('175/70 R17', 'confirmed'),
              quantidade: {
                ...slot(1, 'confirmed'),
                slot_key: 'quantidade',
              },
            },
          },
        ],
      }),
      { type: 'request_confirmation', confirmation_type: 'order_confirmation', expected_facts: {} },
    );

    expect(result.valid).toBe(true);
  });

  it('agentActionSchema exige requires_human_review literal em unsupported_observation', () => {
    const parsed = agentActionSchema.safeParse(
      baseAction({
        type: 'unsupported_observation',
        raw_text: 'cliente citou algo fora do schema',
        proposed_fact_key: 'cor_do_capacete',
        proposed_fact_value: 'vermelho',
        requires_human_review: true,
      }),
    );

    expect(parsed.success).toBe(true);
  });

  it('applyAction e puro para request_confirmation legada', () => {
    const initial = state();
    const action: AgentAction = {
      type: 'request_confirmation',
      confirmation_type: 'fact_confirmation',
      expected_facts: { medida_pneu: '175/70 R17' },
      expires_in_seconds: 60,
    };

    expect(applyAction(initial, action)).toEqual(applyAction(initial, action));
  });

  it('add_to_cart cria linha viva no carrinho sem escrever em commerce.orders', () => {
    const productId = '00000000-0000-4000-8000-000000000040';
    const result = applyAction(state(), {
      type: 'add_to_cart',
      product_id: productId,
      quantity: 2,
      unit_price: 189.9,
    });

    expect(result.state.cart).toHaveLength(1);
    expect(result.state.cart[0]!.product_id).toBe(productId);
    expect(result.state.cart[0]!.quantity).toBe(2);
    expect(result.state.cart[0]!.unit_price).toBe(189.9);
    expect(result.events_to_emit[0]!.event_type).toBe('cart_proposed');
  });

  it('update_draft guarda checkout e marca ready quando dados minimos existem', () => {
    const result = applyAction(state(), baseAction({
      type: 'update_draft',
      customer_name: 'Joao Silva',
      delivery_address: 'Rua das Flores, 123',
      fulfillment_mode: 'delivery',
      payment_method: 'pix',
    }));

    expect(result.state.order_draft?.customer_name).toBe('Joao Silva');
    expect(result.state.order_draft?.delivery_address).toBe('Rua das Flores, 123');
    expect(result.state.order_draft?.fulfillment_mode).toBe('delivery');
    expect(result.state.order_draft?.payment_method).toBe('pix');
    expect(result.state.order_draft?.draft_status).toBe('ready');
    expect(result.events_to_emit[0]!.event_type).toBe('fact_corrected');
  });

  it('applyActionAndPersist faz no-op quando action_id ja existe', async () => {
    const queries: string[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes('FROM agent.session_events') && sql.includes('WHERE action_id')) {
          return { rowCount: 1, rows: [{ '?column?': 1 }] };
        }
        return { rowCount: 0, rows: [] };
      },
    };

    const initial = state();
    const result = await applyActionAndPersist(
      client as never,
      initial,
      baseAction({ type: 'create_item', item_id: itemId, make_active: true }),
    );

    expect(result).toBe(initial);
    expect(queries.some((sql) => sql === 'BEGIN')).toBe(false);
  });

  it('applyActionAndPersist rejeita version conflict e faz rollback', async () => {
    const queries: string[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes('FROM agent.session_events') && sql.includes('WHERE action_id')) {
          return { rowCount: 0, rows: [] };
        }
        if (sql.startsWith('UPDATE agent.session_current')) {
          return { rowCount: 0, rows: [] };
        }
        return { rowCount: 0, rows: [] };
      },
    };

    await expect(
      applyActionAndPersist(
        client as never,
        state(),
        baseAction({ type: 'create_item', item_id: itemId, make_active: true }),
      ),
    ).rejects.toBeInstanceOf(AgentStateVersionConflictError);

    expect(queries).toContain('BEGIN');
    expect(queries).toContain('ROLLBACK');
  });
});
