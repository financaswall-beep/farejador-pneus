/**
 * Integration test do Sprint 6.5 — Caminho B.
 *
 * Garante que applyActionAndPersistInTx, contra Postgres real:
 *  - persiste update_slot em agent.session_slots
 *  - incrementa session_current.version
 *  - emite slot_set em agent.session_events
 *  - é idempotente por action_id
 *  - falha por conflito de versão otimista
 *  - persiste create_item em agent.session_items
 *
 * Os unit tests do worker mockam client.query, então não exercitam SQL real.
 * Este teste fecha essa lacuna.
 *
 * Infraestrutura: tenta testcontainers (Docker local) primeiro.
 * Se não houver Docker, usa DATABASE_URL de .env.codex (Supabase/Postgres externo).
 *
 * Nota de limpeza: agent.session_events é append-only (trigger bloqueia DELETE)
 * e o cascade de core.conversations → session_events também é bloqueado.
 * Por isso, ao rodar contra Supabase externo, conversas e events ficam acumulados
 * no banco de teste — comportamento aceitável para o ambiente 'test'.
 * session_slots, session_items e session_current SÃO limpos.
 */

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres';
import {
  AgentStateVersionConflictError,
  applyActionAndPersistInTx,
  loadCurrent,
} from '../../src/atendente/state/agent-state.repository.js';
import type {
  AddToCartAction,
  EscalateAction,
  CreateItemAction,
  RequestConfirmationAction,
  UpdateCartItemAction,
  UpdateDraftAction,
  UpdateSlotAction,
} from '../../src/shared/zod/agent-actions.js';

// ─── Infraestrutura ───────────────────────────────────────────────────────────

let db: IntegrationDb | null = null;
let testPool: Pool;

/** Par criado em cada beforeEach — usado para cleanup parcial no Supabase externo. */
const createdPairs: Array<{ conversationId: string; contactId: string }> = [];
const createdProductIds: string[] = [];

let conversationId: string;

beforeAll(async () => {
  try {
    db = await startPostgres();
    testPool = db.pool;
  } catch {
    const url = loadCodexDatabaseUrl();
    if (!url) {
      throw new Error(
        'Sem Docker local e sem .env.codex com DATABASE_URL — impossível rodar integration tests.',
      );
    }
    testPool = new Pool({
      connectionString: url,
      ssl: { rejectUnauthorized: false },
      max: 3,
    });
  }
});

afterAll(async () => {
  if (db) {
    await stopPostgres(db);
    return;
  }
  // Supabase externo: limpa o que é possível.
  // session_events é append-only (trigger bloqueia DELETE) e core.conversations
  // tem CASCADE para session_events, então conversas também não podem ser deletadas.
  // Limpamos: slots, items, carrinho, drafts, confirmações, escalações, session_current, contacts.
  for (const { conversationId: cid, contactId: ctid } of createdPairs) {
    try {
      await testPool.query(`DELETE FROM agent.cart_events WHERE environment = 'test' AND conversation_id = $1`, [cid]);
    } catch { /* silencioso */ }
    try {
      await testPool.query(
        `DELETE FROM agent.cart_current_items
         WHERE environment = 'test'
           AND cart_id IN (SELECT id FROM agent.cart_current WHERE environment = 'test' AND conversation_id = $1)`,
        [cid],
      );
    } catch { /* silencioso */ }
    try {
      await testPool.query(`DELETE FROM agent.cart_current WHERE environment = 'test' AND conversation_id = $1`, [cid]);
    } catch { /* silencioso */ }
    try {
      await testPool.query(`DELETE FROM agent.order_drafts WHERE environment = 'test' AND conversation_id = $1`, [cid]);
    } catch { /* silencioso */ }
    try {
      await testPool.query(`DELETE FROM agent.pending_confirmations WHERE environment = 'test' AND conversation_id = $1`, [cid]);
    } catch { /* silencioso */ }
    try {
      await testPool.query(`DELETE FROM agent.escalations WHERE environment = 'test' AND conversation_id = $1`, [cid]);
    } catch { /* silencioso */ }
    try {
      await testPool.query(
        `DELETE FROM agent.session_slots WHERE environment = 'test' AND conversation_id = $1`,
        [cid],
      );
    } catch { /* silencioso */ }
    try {
      await testPool.query(
        `DELETE FROM agent.session_items WHERE environment = 'test' AND conversation_id = $1`,
        [cid],
      );
    } catch { /* silencioso */ }
    try {
      await testPool.query(
        `DELETE FROM agent.session_current WHERE environment = 'test' AND conversation_id = $1`,
        [cid],
      );
    } catch { /* silencioso */ }
    try {
      // Anula FK antes de deletar contact (conversa fica órfã mas não bloqueia)
      await testPool.query(`UPDATE core.conversations SET contact_id = NULL WHERE id = $1`, [cid]);
      await testPool.query(`DELETE FROM core.contacts WHERE id = $1`, [ctid]);
    } catch { /* silencioso */ }
  }
  for (const productId of createdProductIds) {
    try {
      await testPool.query(`DELETE FROM commerce.products WHERE environment = 'test' AND id = $1`, [productId]);
    } catch { /* silencioso */ }
  }
  await testPool.end();
});

beforeEach(async () => {
  // Cria contact + conversation + session_current zerados pra cada teste
  const contact = await testPool.query<{ id: string }>(
    `INSERT INTO core.contacts (environment, chatwoot_contact_id, name)
     VALUES ('test', $1, 'Teste 6.5')
     RETURNING id`,
    [Math.floor(Math.random() * 1_000_000_000)],
  );
  const contactId = contact.rows[0]!.id;

  const conv = await testPool.query<{ id: string }>(
    `INSERT INTO core.conversations
       (environment, chatwoot_conversation_id, chatwoot_account_id,
        contact_id, current_status, started_at)
     VALUES ('test', $1, 1, $2, 'open', now())
     RETURNING id`,
    [Math.floor(Math.random() * 1_000_000_000), contactId],
  );
  conversationId = conv.rows[0]!.id;

  createdPairs.push({ conversationId, contactId });

  await testPool.query(
    `INSERT INTO agent.session_current (environment, conversation_id, status)
     VALUES ('test', $1, 'active')`,
    [conversationId],
  );
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * Constrói um UpdateSlotAction. action_id é obrigatório para garantir unicidade
 * entre runs contra Supabase compartilhado (idempotency check é global).
 */
function makeUpdateSlotAction(
  itemId: string | null,
  actionId: string,
  overrides: Partial<UpdateSlotAction> = {},
): UpdateSlotAction {
  return {
    type: 'update_slot',
    action_id: actionId,
    turn_index: 1,
    emitted_at: '2026-05-04T12:00:00.000Z',
    emitted_by: 'generator',
    scope: itemId ? 'item' : 'global',
    item_id: itemId,
    slot_key: itemId ? 'medida_pneu' : 'bairro',
    value: itemId ? '140/70-17' : 'Bonsucesso',
    source: 'observed',
    confidence: 0.95,
    evidence_text: itemId ? 'pneu 140/70-17' : 'sou de Bonsucesso',
    set_by_message_id: '00000000-0000-4000-8000-0000000000aa',
    set_by_skill: 'buscar_e_ofertar',
    ...overrides,
  };
}

function makeCreateItemAction(itemId: string, actionId: string): CreateItemAction {
  return {
    type: 'create_item',
    action_id: actionId,
    turn_index: 1,
    emitted_at: '2026-05-04T12:00:00.000Z',
    emitted_by: 'generator',
    item_id: itemId,
    make_active: true,
  };
}

function makeAddToCartAction(productId: string): AddToCartAction {
  return {
    type: 'add_to_cart',
    product_id: productId,
    quantity: 2,
    unit_price: 189.9,
  };
}

function makeUpdateDraftAction(): UpdateDraftAction {
  return {
    type: 'update_draft',
    action_id: randomUUID(),
    turn_index: 1,
    emitted_at: '2026-05-04T12:00:00.000Z',
    emitted_by: 'generator',
    customer_name: 'Cliente Teste',
    delivery_address: 'Rua Teste, 123',
    fulfillment_mode: 'delivery',
    payment_method: 'pix',
  };
}

function makeUpdateCartItemAction(cartItemId: string): UpdateCartItemAction {
  return {
    type: 'update_cart_item',
    cart_item_id: cartItemId,
    quantity: 3,
  };
}

function makeRequestConfirmationAction(): RequestConfirmationAction {
  return {
    type: 'request_confirmation',
    confirmation_type: 'order_confirmation',
    expected_facts: { medida_pneu: '140/70-17', quantidade: 2 },
    expires_in_seconds: 3600,
  };
}

function makeEscalateAction(): EscalateAction {
  return {
    type: 'escalate',
    reason: 'ready_to_close',
    summary_text: 'Cliente quer fechar pedido com entrega e pagamento por pix.',
  };
}

async function createProduct(): Promise<string> {
  const result = await testPool.query<{ id: string }>(
    `INSERT INTO commerce.products
       (environment, product_code, product_name, product_type, brand)
     VALUES ('test', $1, 'Pneu Teste 140/70-17', 'tire', 'Teste')
     RETURNING id`,
    [`TEST-${randomUUID()}`],
  );
  const productId = result.rows[0]!.id;
  createdProductIds.push(productId);
  return productId;
}

// ─── Testes ───────────────────────────────────────────────────────────────────

describe('Sprint 6.5/6.9 — applyActionAndPersistInTx contra Postgres real', () => {
  it('persiste update_slot global, incrementa version e emite slot_set', async () => {
    const actionId = randomUUID();
    const client = await testPool.connect();
    try {
      await client.query('BEGIN');
      const state = await loadCurrent(client, 'test', conversationId);
      expect(state).not.toBeNull();
      expect(state!.version).toBe(0);

      const action = makeUpdateSlotAction(null, actionId);
      const next = await applyActionAndPersistInTx(client, state!, action);
      expect(next.version).toBe(1);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    // Lê de volta direto do banco
    const slot = await testPool.query(
      `SELECT scope, slot_key, value_json, source, stale, requires_confirmation
       FROM agent.session_slots
       WHERE conversation_id = $1`,
      [conversationId],
    );
    expect(slot.rowCount).toBe(1);
    expect(slot.rows[0]!.scope).toBe('global');
    expect(slot.rows[0]!.slot_key).toBe('bairro');
    expect(slot.rows[0]!.value_json).toBe('Bonsucesso');
    expect(slot.rows[0]!.source).toBe('observed');
    expect(slot.rows[0]!.stale).toBe('fresh');

    const version = await testPool.query<{ version: string }>(
      `SELECT version::text AS version FROM agent.session_current WHERE conversation_id = $1`,
      [conversationId],
    );
    expect(version.rows[0]!.version).toBe('1');

    const event = await testPool.query<{ event_type: string; emitted_by: string }>(
      `SELECT event_type, emitted_by FROM agent.session_events WHERE conversation_id = $1`,
      [conversationId],
    );
    expect(event.rows[0]!.event_type).toBe('slot_set');
    expect(event.rows[0]!.emitted_by).toBe('generator');
  });

  it('persiste create_item + update_slot item em sequência', async () => {
    const itemId = randomUUID();
    const actionCreate = randomUUID();
    const actionSlot = randomUUID();
    const client = await testPool.connect();
    try {
      await client.query('BEGIN');
      const state0 = await loadCurrent(client, 'test', conversationId);
      const state1 = await applyActionAndPersistInTx(
        client,
        state0!,
        makeCreateItemAction(itemId, actionCreate),
      );
      const state2 = await applyActionAndPersistInTx(
        client,
        state1,
        makeUpdateSlotAction(itemId, actionSlot),
      );
      expect(state2.version).toBe(2);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const items = await testPool.query(
      `SELECT id, status, is_active FROM agent.session_items WHERE conversation_id = $1`,
      [conversationId],
    );
    expect(items.rowCount).toBe(1);
    expect(items.rows[0]!.id).toBe(itemId);
    expect(items.rows[0]!.is_active).toBe(true);

    const slot = await testPool.query(
      `SELECT scope, slot_key, item_id FROM agent.session_slots WHERE conversation_id = $1`,
      [conversationId],
    );
    expect(slot.rowCount).toBe(1);
    expect(slot.rows[0]!.scope).toBe('item');
    expect(slot.rows[0]!.item_id).toBe(itemId);
  });

  it('é idempotente: action_id repetido vira no-op silencioso', async () => {
    const actionId = randomUUID(); // único neste run
    const action = makeUpdateSlotAction(null, actionId);
    const client = await testPool.connect();
    try {
      await client.query('BEGIN');
      const state0 = await loadCurrent(client, 'test', conversationId);
      const state1 = await applyActionAndPersistInTx(client, state0!, action);
      expect(state1.version).toBe(1);

      // Mesma action_id - deve retornar estado de entrada sem incrementar
      const state2 = await applyActionAndPersistInTx(client, state1, action);
      expect(state2).toBe(state1);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const count = await testPool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM agent.session_events
       WHERE conversation_id = $1 AND event_type = 'slot_set'`,
      [conversationId],
    );
    expect(count.rows[0]!.c).toBe('1');
  });

  it('falha com AgentStateVersionConflictError quando version desbatida', async () => {
    const actionId = randomUUID();
    const client = await testPool.connect();
    try {
      await client.query('BEGIN');
      const state0 = await loadCurrent(client, 'test', conversationId);

      // Simula que outro processo já avançou a versão pra 1
      await client.query(
        `UPDATE agent.session_current SET version = version + 1 WHERE conversation_id = $1`,
        [conversationId],
      );

      // state0.version ainda é 0; mas no banco já está 1 → conflito
      const action = makeUpdateSlotAction(null, actionId);
      await expect(applyActionAndPersistInTx(client, state0!, action)).rejects.toBeInstanceOf(
        AgentStateVersionConflictError,
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('SAVEPOINT do worker: action que falha não derruba as anteriores', async () => {
    // Reproduz o padrão do worker: SAVEPOINT por action.
    // Action 1: cria item (persiste). Action 2: slot item com item_id null = violação.
    // Esperado: state final tem slot da action 1, version=2.
    const itemId = randomUUID();
    const actionCreate = randomUUID();
    const actionSlot = randomUUID();
    const actionBroken = randomUUID();
    const client = await testPool.connect();
    try {
      await client.query('BEGIN');
      const state0 = await loadCurrent(client, 'test', conversationId);
      const state1 = await applyActionAndPersistInTx(
        client,
        state0!,
        makeCreateItemAction(itemId, actionCreate),
      );

      await client.query('SAVEPOINT a1');
      const state2 = await applyActionAndPersistInTx(
        client,
        state1,
        makeUpdateSlotAction(itemId, actionSlot),
      );
      await client.query('RELEASE SAVEPOINT a1');

      // Action que vai falhar: item slot sem item_id
      await client.query('SAVEPOINT a2');
      const broken: UpdateSlotAction = {
        ...makeUpdateSlotAction(null, actionBroken),
        scope: 'item',
        item_id: null,
        slot_key: 'medida_pneu',
      };
      await expect(applyActionAndPersistInTx(client, state2, broken)).rejects.toThrow();
      await client.query('ROLLBACK TO SAVEPOINT a2');

      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const slots = await testPool.query(
      `SELECT slot_key FROM agent.session_slots WHERE conversation_id = $1`,
      [conversationId],
    );
    expect(slots.rowCount).toBe(1);
    expect(slots.rows[0]!.slot_key).toBe('medida_pneu');

    const version = await testPool.query<{ version: string }>(
      `SELECT version::text AS version FROM agent.session_current WHERE conversation_id = $1`,
      [conversationId],
    );
    expect(version.rows[0]!.version).toBe('2');
  });

  it('persiste add_to_cart em cart_current, cart_current_items e cart_events', async () => {
    const productId = await createProduct();
    const client = await testPool.connect();
    try {
      await client.query('BEGIN');
      const state0 = await loadCurrent(client, 'test', conversationId);
      const next = await applyActionAndPersistInTx(client, state0!, makeAddToCartAction(productId));
      expect(next.cart).toHaveLength(1);
      expect(next.version).toBe(1);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const cart = await testPool.query<{ cart_status: string; estimated_total: string | null }>(
      `SELECT cart_status, estimated_total::text AS estimated_total
       FROM agent.cart_current
       WHERE environment = 'test' AND conversation_id = $1`,
      [conversationId],
    );
    expect(cart.rows[0]!.cart_status).toBe('proposed');
    expect(cart.rows[0]!.estimated_total).toBe('379.80');

    const items = await testPool.query(
      `SELECT product_id, quantity, unit_price::text AS unit_price, item_status
       FROM agent.cart_current_items
       WHERE environment = 'test'`,
    );
    expect(items.rows.some((row) => row.product_id === productId && row.quantity === 2)).toBe(true);

    const event = await testPool.query<{ event_type: string }>(
      `SELECT event_type
       FROM agent.cart_events
       WHERE environment = 'test' AND conversation_id = $1`,
      [conversationId],
    );
    expect(event.rows[0]!.event_type).toBe('proposed');

    const sessionEvent = await testPool.query<{ event_type: string }>(
      `SELECT event_type
       FROM agent.session_events
       WHERE environment = 'test' AND conversation_id = $1`,
      [conversationId],
    );
    expect(sessionEvent.rows[0]!.event_type).toBe('cart_added');
  });

  it('persiste update_cart_item como cart_updated e cart_event updated', async () => {
    const productId = await createProduct();
    let cartItemId: string;
    const client = await testPool.connect();
    try {
      await client.query('BEGIN');
      const state0 = await loadCurrent(client, 'test', conversationId);
      const state1 = await applyActionAndPersistInTx(client, state0!, makeAddToCartAction(productId));
      cartItemId = state1.cart[0]!.id;
      const state2 = await applyActionAndPersistInTx(client, state1, makeUpdateCartItemAction(cartItemId));
      expect(state2.cart[0]!.quantity).toBe(3);
      expect(state2.version).toBe(2);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const item = await testPool.query<{ quantity: number }>(
      `SELECT quantity
       FROM agent.cart_current_items
       WHERE environment = 'test'
         AND cart_id IN (SELECT id FROM agent.cart_current WHERE environment = 'test' AND conversation_id = $1)`,
      [conversationId],
    );
    expect(item.rows[0]!.quantity).toBe(3);

    const cartEvents = await testPool.query<{ event_type: string }>(
      `SELECT event_type
       FROM agent.cart_events
       WHERE environment = 'test' AND conversation_id = $1
       ORDER BY occurred_at ASC`,
      [conversationId],
    );
    expect(cartEvents.rows.map((row) => row.event_type)).toEqual(['proposed', 'updated']);

    const sessionEvents = await testPool.query<{ event_type: string }>(
      `SELECT event_type
       FROM agent.session_events
       WHERE environment = 'test' AND conversation_id = $1
       ORDER BY turn_index ASC, event_type ASC`,
      [conversationId],
    );
    expect(sessionEvents.rows.map((row) => row.event_type)).toEqual(['cart_added', 'cart_updated']);
  });

  it('persiste update_draft, request_confirmation e escalation nas tabelas operacionais', async () => {
    const itemId = randomUUID();
    const client = await testPool.connect();
    try {
      await client.query('BEGIN');
      const state0 = await loadCurrent(client, 'test', conversationId);
      const state1 = await applyActionAndPersistInTx(
        client,
        state0!,
        makeCreateItemAction(itemId, randomUUID()),
      );
      const state2 = await applyActionAndPersistInTx(
        client,
        state1,
        makeUpdateSlotAction(itemId, randomUUID(), {
          slot_key: 'quantidade',
          value: 2,
          source: 'confirmed',
        }),
      );
      const state3 = await applyActionAndPersistInTx(
        client,
        state2,
        makeUpdateSlotAction(itemId, randomUUID(), {
          slot_key: 'medida_pneu',
          value: '140/70-17',
          source: 'confirmed',
        }),
      );
      const state4 = await applyActionAndPersistInTx(client, state3, makeUpdateDraftAction());
      const state5 = await applyActionAndPersistInTx(client, state4, makeRequestConfirmationAction());
      const state6 = await applyActionAndPersistInTx(client, state5, makeEscalateAction());
      expect(state6.status).toBe('escalated');
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const draft = await testPool.query<{ draft_status: string; payment_method: string }>(
      `SELECT draft_status, payment_method
       FROM agent.order_drafts
       WHERE environment = 'test' AND conversation_id = $1`,
      [conversationId],
    );
    expect(draft.rows[0]!.draft_status).toBe('ready');
    expect(draft.rows[0]!.payment_method).toBe('pix');

    const confirmation = await testPool.query<{ confirmation_type: string; status: string }>(
      `SELECT confirmation_type, status
       FROM agent.pending_confirmations
       WHERE environment = 'test' AND conversation_id = $1`,
      [conversationId],
    );
    expect(confirmation.rows[0]!.confirmation_type).toBe('order_confirmation');
    expect(confirmation.rows[0]!.status).toBe('open');

    const escalation = await testPool.query<{ reason: string; status: string }>(
      `SELECT reason, status
       FROM agent.escalations
       WHERE environment = 'test' AND conversation_id = $1`,
      [conversationId],
    );
    expect(escalation.rows[0]!.reason).toBe('ready_to_close');
    expect(escalation.rows[0]!.status).toBe('waiting');

    const session = await testPool.query<{ status: string }>(
      `SELECT status FROM agent.session_current WHERE environment = 'test' AND conversation_id = $1`,
      [conversationId],
    );
    expect(session.rows[0]!.status).toBe('escalated');
  });
});

// ─── Helper ───────────────────────────────────────────────────────────────────

function loadCodexDatabaseUrl(): string | null {
  try {
    const text = readFileSync('.env.codex', 'utf-8');
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^DATABASE_URL=(.*)$/);
      if (match) return match[1]!.trim();
    }
    return null;
  } catch {
    return null;
  }
}
