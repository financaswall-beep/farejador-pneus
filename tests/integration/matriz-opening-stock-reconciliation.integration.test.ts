import type { Pool, PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

// Medida e quantidade dos 24 ajustes de novembro. Todos os pneus entraram a R$ 20.
const openings: [string, number][] = [
  ['265/60', 1], ['265/60', 2], ['265/60', 1], ['265/60', 13], ['265/60', 3],
  ['255/60', 1], ['235/60', 1], ['255/60', 1], ['255/55', 1], ['235/50', 1],
  ['225/55', 1], ['225/55', 1], ['225/45', 1], ['225/45', 1], ['235/45', 1],
  ['225/55', 3], ['245/45', 1], ['215/45', 1], ['235/50', 1], ['235/55', 3],
  ['235/55', 1], ['215/45', 2], ['235/55', 2], ['225/40', 1],
];
const lastRef = 'opening-' + (openings.length - 1);

describe('Conciliação do saldo inicial de estoque da Matriz', () => {
  let db: IntegrationDb, client: PoolClient;
  let post: typeof import('../../src/admin/painel/matriz-ledger-inventory.js').postMatrizInventoryAdjustmentsByMovementRef;
  let monthly: typeof import('../../src/admin/painel/matriz-ledger-financial-read.js').getMatrizCentralLedgerFinancialTruth;
  let gate: typeof import('../../src/admin/painel/matriz-ledger-competence-gate.js').getMatrizLedgerCompetenceGate;

  beforeAll(async () => {
    db = await startPostgres();
    Object.assign(process.env, {
      NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: db.connectionString,
      CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'test-token',
      MATRIZ_CENTRAL_LEDGER: 'true', MATRIZ_CENTRAL_LEDGER_READ: 'true',
    });
    vi.resetModules();
    ({ postMatrizInventoryAdjustmentsByMovementRef: post } = await import('../../src/admin/painel/matriz-ledger-inventory.js'));
    ({ getMatrizCentralLedgerFinancialTruth: monthly } = await import('../../src/admin/painel/matriz-ledger-financial-read.js'));
    ({ getMatrizLedgerCompetenceGate: gate } = await import('../../src/admin/painel/matriz-ledger-competence-gate.js'));
    const seed = await db.pool.connect();
    try {
      await seed.query('BEGIN');
      await seed.query("SET LOCAL app.galpao_nature = 'opening_balance'");
      const quantities = new Map<string, number>();
      for (const [i, [size, quantity]] of openings.entries()) {
        const measure = size + '-18', before = quantities.get(measure) ?? 0;
        const ref = 'opening-' + i;
        await seed.query(`INSERT INTO commerce.wholesale_stock_movements
          (environment,measure,brand,tire_condition,op,qty_before,qty_after,cost_before,cost_after,source,ref,created_at)
          VALUES ('test',$1,'Sem marca','meia_vida',$2,$3,$4,20,20,'entrada',$5,$6::timestamptz)`,
        [measure, before ? 'update' : 'insert', before, before + quantity, ref,
          i < 5 ? '2026-11-24T21:52:00-03:00' : '2026-11-25T00:45:00-03:00']);
        quantities.set(measure, before + quantity);
        if (ref !== lastRef) await post(seed, 'test', ref);
      }
      await seed.query('COMMIT');
    } catch (error) {
      await seed.query('ROLLBACK');
      throw error;
    } finally {
      seed.release();
    }
  }, 180_000);

  beforeEach(async () => {
    client = await db.pool.connect();
    await client.query('BEGIN');
  });
  afterEach(async () => {
    if (client) { await client.query('ROLLBACK'); client.release(); }
  });
  afterAll(async () => { if (db) await stopPostgres(db); });

  async function checkReports(accounted: string, difference: string, source = '900.00') {
    // Ambas as consultas precisam ler a mesma transação descartável.
    const session = client as unknown as Pool;
    const report = await monthly('test', session, '2026-11');
    const integrity = await gate(['2026-10-01', '2026-11-01'], 'test', session);
    const matched = difference === '0.00';
    expect(report.conciliacao).toMatchObject({ diferenca_total: difference, status: matched ? 'ok' : 'divergente' });
    expect(report.conciliacao.origens.find(r => r.origem === 'estoque')).toMatchObject({
      origem_total: source, contabilizado: accounted, diferenca: difference,
    });
    expect(integrity.status).toBe(matched ? 'green' : 'red');
    expect(integrity.competences.find(c => c.competence === '2026-11-01')?.origins.find(r => r.origin === 'estoque'))
      .toMatchObject({ source_total: source, ledger_total: accounted, difference, matched });
    return report;
  }

  it('concilia os 45 pneus sem alterar as partidas, o custo, o resultado ou o caixa', async () => {
    await post(client, 'test', lastRef);
    const snapshot = async () => (await client.query(`SELECT
      (SELECT count(*)::int FROM commerce.wholesale_stock_movements WHERE environment='test') movements,
      (SELECT sum(quantity_delta)::int FROM finance.matriz_inventory_adjustments WHERE environment='test') quantity,
      sum(e.amount) FILTER (WHERE account_code='inventory' AND side='debit') stock,
      sum(e.amount) FILTER (WHERE account_code='opening_equity' AND side='credit') equity,
      count(*)::int lines FROM finance.matriz_ledger_entries e WHERE environment='test'`)).rows[0];
    const before = await snapshot();
    expect(before).toEqual({ movements: 24, quantity: 45, stock: '900.00', equity: '900.00', lines: 48 });
    const report = await checkReports('900.00', '0.00');
    expect(report.competencia).toMatchObject({ receita_total: '0.00', despesas: '0.00', custo_conhecido: '0.00', lucro_confirmado: '0.00' });
    expect(report.caixa).toMatchObject({ entradas_registradas: '0.00', saidas_registradas: '0.00', saldo_atual: '0.00' });
    expect(await snapshot()).toEqual(before);
  });

  it('detecta a falta de uma única contrapartida, mesmo com todo o débito em estoque', async () => {
    // O constraint de balanço é diferido. O teste lê a partida parcial nesta sessão
    // e o afterEach desfaz a transação antes que ela seja confirmada.
    const partial = await client.query(`INSERT INTO finance.matriz_ledger_transactions
        (environment,source_type,source_id,transaction_kind,amount,competence_on,description,created_by,request_fingerprint)
      SELECT environment,'finance.inventory_adjustment',id::text,'inventory_gain',amount,'2026-11-25',
        'Abertura sem contrapartida','fixture',md5(id::text) FROM finance.matriz_inventory_adjustments
      WHERE environment='test' AND movement_ref=$1 RETURNING id,amount`, [lastRef]);
    await client.query(`INSERT INTO finance.matriz_ledger_entries
      (environment,transaction_id,line_no,account_code,account_class,side,amount)
      VALUES ('test',$1,1,'inventory','asset','debit',$2)`, [partial.rows[0].id, partial.rows[0].amount]);
    expect((await client.query(`SELECT sum(amount) total FROM finance.matriz_ledger_entries
      WHERE environment='test' AND account_code='inventory' AND side='debit'`)).rows[0].total).toBe('900.00');
    await checkReports('880.00', '20.00');
  });

  it('concilia aporte em pneus e separa abertura, aporte e retirada em dinheiro', async () => {
    await post(client, 'test', lastRef);
    await client.query("SET LOCAL app.galpao_nature = 'owner_contribution'");
    await client.query(`INSERT INTO commerce.wholesale_stock_movements
      (environment,measure,brand,tire_condition,op,qty_before,qty_after,cost_before,cost_after,source,ref,created_at)
      VALUES ('test','225/40-18','Sem marca','meia_vida','update',1,3,20,20,'entrada','stock-contribution','2026-11-25T14:00:00Z')`);
    await post(client, 'test', 'stock-contribution');
    for (const [source, equity, amount] of [
      ['finance.manual_entry', 'owner_equity', 50],
      ['finance.cash.opening', 'opening_equity', 100],
    ] as const) {
      await client.query(`SELECT finance.post_matriz_ledger_transaction('test',$1,$1,'recognition',$2,
        '2026-11-25','Entrada em dinheiro','fixture',$3::jsonb,NULL,'2026-11-25','{}'::jsonb)`, [
        source, amount, JSON.stringify([
          { account_code: 'cash', account_class: 'asset', side: 'debit', amount },
          { account_code: equity, account_class: 'equity', side: 'credit', amount },
        ]),
      ]);
    }
    const { createOwnerWithdrawalOnClient } = await import('../../src/admin/painel/matriz-owner-withdrawal.js');
    await createOwnerWithdrawalOnClient(client, {
      amount: 30, occurred_at: '2026-11-25T14:00:00Z', reason: 'Retirada em dinheiro',
      payment_method: 'dinheiro', cash_account: 'Caixa', idempotency_key: 'withdrawal-fixture',
    }, 'fixture', 'test');
    const report = await checkReports('940.00', '0.00', '940.00');
    expect(report.caixa).toMatchObject({ entradas_registradas: '150.00', saidas_registradas: '30.00', saldo_atual: '120.00' });
  });
});
