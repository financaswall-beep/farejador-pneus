import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('Etapa 3 — ajustes de estoque no livro central', () => {
  let db: IntegrationDb;
  let sequence = 0;
  let addEntry: typeof import(
    '../../src/admin/painel/queries-galpao-movimentos.js'
  ).addWholesaleStockEntryComRotulo;
  let applyDecrement: typeof import(
    '../../src/admin/painel/queries-galpao-movimentos.js'
  ).applyGalpaoBaixaManual;
  let setStock: typeof import(
    '../../src/admin/painel/queries-galpao-movimentos.js'
  ).setWholesaleStockComRotulo;
  let removeStock: typeof import(
    '../../src/admin/painel/queries-galpao-movimentos.js'
  ).deleteWholesaleStockComRotulo;
  let applyPhysicalCount: typeof import(
    '../../src/admin/painel/queries-stock-physical-count.js'
  ).applyMatrizPhysicalStockCount;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
      CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'emergency-token',
      MATRIZ_CENTRAL_LEDGER: 'true',
    });
    vi.resetModules();
    db = await startPostgres();
    ({
      addWholesaleStockEntryComRotulo: addEntry,
      applyGalpaoBaixaManual: applyDecrement,
      setWholesaleStockComRotulo: setStock,
      deleteWholesaleStockComRotulo: removeStock,
    } = await import('../../src/admin/painel/queries-galpao-movimentos.js'));
    ({ applyMatrizPhysicalStockCount: applyPhysicalCount } = await import(
      '../../src/admin/painel/queries-stock-physical-count.js'
    ));
  }, 180_000);

  afterAll(async () => {
    if (db) await stopPostgres(db);
    process.env.MATRIZ_CENTRAL_LEDGER = 'false';
  });

  async function fixture(): Promise<string> {
    sequence += 1;
    const measure = `${220 + sequence}/${35 + sequence}-${13 + sequence}`;
    const product = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.products
         (environment,product_code,product_name,product_type)
       VALUES ('test',$1,$2,'tire') RETURNING id`,
      [`LEDGER-I-${sequence}`, `Pneu estoque ${sequence}`],
    );
    await db.pool.query(
      `INSERT INTO commerce.tire_specs
         (environment,product_id,tire_size,width_mm,aspect_ratio,rim_diameter)
       VALUES ('test',$1,$2,$3,$4,$5)`,
      [product.rows[0]!.id, measure, 220 + sequence, 35 + sequence, 13 + sequence],
    );
    return measure;
  }

  async function postingByRef(ref: string) {
    return db.pool.query(
      `SELECT a.direction,a.nature,a.amount::text,t.transaction_kind,
              jsonb_object_agg(e.account_code,e.side ORDER BY e.line_no) entries,
              count(DISTINCT t.id)::int transaction_count
         FROM finance.matriz_inventory_adjustments a
         JOIN finance.matriz_ledger_transactions t
          ON t.environment=a.environment
          AND t.source_type='finance.inventory_adjustment'
          AND t.source_id=a.id::text
         JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id
        WHERE a.environment='test' AND a.movement_ref=$1
        GROUP BY a.id,t.id`,
      [ref],
    );
  }

  it('aporte do dono vira patrimonio, nao receita, e replay nao duplica', async () => {
    const measure = await fixture();
    const idempotencyKey = randomUUID();
    const input = {
      environment: 'test' as const, measure, quantity_in: 3, unit_cost: 20,
      entry_nature: 'owner_contribution' as const, reason: 'aporte inicial do dono',
      actor_label: 'owner:inventory', idempotency_key: idempotencyKey,
    };
    const first = await addEntry(input, db.pool);
    expect(await addEntry(input, db.pool)).toEqual(first);

    const proof = await postingByRef(idempotencyKey);
    expect(proof.rows).toHaveLength(1);
    expect(proof.rows[0]).toMatchObject({
      direction: 'gain',
      nature: 'owner_contribution',
      amount: '60.00',
      transaction_kind: 'inventory_gain',
      entries: { inventory: 'debit', owner_equity: 'credit' },
      transaction_count: 1,
    });
  });

  it('estoque encontrado reconhece ganho operacional separado', async () => {
    const measure = await fixture();
    const idempotencyKey = randomUUID();
    await addEntry({
      environment: 'test', measure, quantity_in: 2, unit_cost: 15,
      entry_nature: 'inventory_found', reason: 'contagem encontrou duas unidades',
      idempotency_key: idempotencyKey,
    }, db.pool);

    const proof = await postingByRef(idempotencyKey);
    expect(proof.rows[0]).toMatchObject({
      direction: 'gain',
      nature: 'inventory_found',
      amount: '30.00',
      entries: { inventory: 'debit', inventory_gain: 'credit' },
    });
  });

  it('quebra reconhece despesa e reduz o ativo de estoque', async () => {
    const measure = await fixture();
    await addEntry({
      environment: 'test', measure, quantity_in: 4, unit_cost: 25,
      entry_nature: 'opening_balance', reason: 'saldo de abertura controlado',
      idempotency_key: randomUUID(),
    }, db.pool);
    const idempotencyKey = randomUUID();
    await applyDecrement({
      environment: 'test', measure, quantity: 2, nature: 'breakage',
      reason: 'duas unidades danificadas', idempotency_key: idempotencyKey,
    }, db.pool);

    const proof = await postingByRef(idempotencyKey);
    expect(proof.rows[0]).toMatchObject({
      direction: 'loss',
      nature: 'breakage',
      amount: '50.00',
      transaction_kind: 'inventory_loss',
      entries: { inventory_loss: 'debit', inventory: 'credit' },
    });
  });

  it('definicao e remocao manual tambem chegam ao livro central', async () => {
    const measure = await fixture();
    await setStock({
      environment: 'test', measure, quantity_on_hand: 5, unit_cost: 12,
      reason: 'definicao inicial do teste',
      actor_label: 'owner:inventory',
    }, db.pool);
    await removeStock(measure, 'test', db.pool);

    const proof = await db.pool.query(
      `SELECT a.source,a.direction,t.transaction_kind,
              jsonb_object_agg(e.account_code,e.side ORDER BY e.line_no) entries
         FROM finance.matriz_inventory_adjustments a
         JOIN finance.matriz_ledger_transactions t
          ON t.source_type='finance.inventory_adjustment'
          AND t.environment=a.environment AND t.source_id=a.id::text
         JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id
        WHERE a.environment='test' AND a.measure=$1
        GROUP BY a.id,t.id
        ORDER BY a.occurred_at,a.id`,
      [measure],
    );
    expect(proof.rows).toEqual([
      {
        source: 'definir',
        direction: 'gain',
        transaction_kind: 'inventory_gain',
        entries: { inventory: 'debit', inventory_gain: 'credit' },
      },
      {
        source: 'remocao',
        direction: 'loss',
        transaction_kind: 'inventory_loss',
        entries: { inventory_loss: 'debit', inventory: 'credit' },
      },
    ]);
  });

  it('contagem fisica ajusta saldo, livro e auditoria com replay idempotente', async () => {
    const measure = await fixture();
    await setStock({
      environment: 'test', measure, quantity_on_hand: 5, unit_cost: 12,
      reason: 'saldo anterior a contagem',
      actor_label: 'owner:inventory',
    }, db.pool);
    const idempotencyKey = randomUUID();
    const input = {
      environment: 'test' as const,
      rows: [{ measure, counted_quantity: 3 }],
      reason: 'inventario mensal',
      idempotency_key: idempotencyKey,
      actor_label: 'owner:inventory',
    };
    const first = await applyPhysicalCount(input, db.pool);
    expect(first).toMatchObject({ checked: 1, changed: 1, gains: 0, losses: 2 });
    expect(await applyPhysicalCount(input, db.pool)).toEqual(first);

    const stock = await db.pool.query(
      `SELECT quantity_on_hand FROM commerce.wholesale_stock
        WHERE environment='test' AND measure=$1`,
      [measure],
    );
    expect(stock.rows[0]?.quantity_on_hand).toBe(3);
    const proof = await postingByRef(idempotencyKey);
    expect(proof.rows).toHaveLength(1);
    expect(proof.rows[0]).toMatchObject({
      direction: 'loss',
      nature: 'inventory_count',
      amount: '24.00',
      transaction_kind: 'inventory_loss',
      entries: { inventory_loss: 'debit', inventory: 'credit' },
      transaction_count: 1,
    });
    const audit = await db.pool.query(
      `SELECT count(*)::int count FROM audit.events
        WHERE environment='test' AND idempotency_key=$1
          AND event_type='physical_count_confirmed'`,
      [idempotencyKey],
    );
    expect(audit.rows[0]?.count).toBe(1);
  });
});
