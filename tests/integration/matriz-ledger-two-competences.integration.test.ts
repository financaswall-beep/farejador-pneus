import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('Portao final — conciliacao central em duas competencias', () => {
  let db: IntegrationDb;
  let sequence = 0;
  let registerSupplier: typeof import(
    '../../src/admin/painel/queries-fornecedores.js'
  ).registerWholesaleSupplier;
  let registerPurchase: typeof import(
    '../../src/admin/painel/queries-fornecedores-registro.js'
  ).registerWholesalePurchase;
  let registerSale: typeof import(
    '../../src/admin/painel/queries-atacado-vendas.js'
  ).registerWholesaleSale;
  let insertExpense: typeof import(
    '../../src/admin/painel/queries-financeiro-integridade.js'
  ).insertMatrizExpenseInTransaction;
  let removeExpense: typeof import(
    '../../src/admin/painel/queries-financeiro-integridade.js'
  ).removeMatrizExpense;
  let reconcileMarketing: typeof import(
    '../../src/marketing/matriz-ledger-spend.js'
  ).reconcileMatrizMarketingSpend;
  let getGate: typeof import(
    '../../src/admin/painel/matriz-ledger-competence-gate.js'
  ).getMatrizLedgerCompetenceGate;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      FAREJADOR_ENV: 'test',
      DATABASE_URL: 'postgres://test',
      CHATWOOT_HMAC_SECRET: 'test-secret',
      ADMIN_AUTH_TOKEN: 'emergency-token',
      ADMIN_BEARER_FALLBACK_ENABLED: 'true',
      WHOLESALE_FINANCE: 'true',
      MATRIZ_CENTRAL_LEDGER: 'true',
    });
    vi.resetModules();
    db = await startPostgres();
    process.env.DATABASE_URL = db.connectionString;
    vi.resetModules();
    ({ registerWholesaleSupplier: registerSupplier }
      = await import('../../src/admin/painel/queries-fornecedores.js'));
    ({ registerWholesalePurchase: registerPurchase }
      = await import('../../src/admin/painel/queries-fornecedores-registro.js'));
    ({ registerWholesaleSale: registerSale }
      = await import('../../src/admin/painel/queries-atacado-vendas.js'));
    ({
      insertMatrizExpenseInTransaction: insertExpense,
      removeMatrizExpense: removeExpense,
    }
      = await import('../../src/admin/painel/queries-financeiro-integridade.js'));
    ({ reconcileMatrizMarketingSpend: reconcileMarketing }
      = await import('../../src/marketing/matriz-ledger-spend.js'));
    ({ getMatrizLedgerCompetenceGate: getGate }
      = await import('../../src/admin/painel/matriz-ledger-competence-gate.js'));
  }, 180_000);

  afterAll(async () => {
    const { pool } = await import('../../src/persistence/db.js');
    await pool.end();
    if (db) await stopPostgres(db);
    process.env.MATRIZ_CENTRAL_LEDGER = 'false';
  });

  async function seedCompetence(month: '2026-06' | '2026-07') {
    sequence += 1;
    const day = `${month}-05`;
    const measure = `${220 + sequence}/${40 + sequence}-${13 + sequence}`;
    const product = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.products
         (environment,product_code,product_name,product_type)
       VALUES ('test',$1,$2,'tire') RETURNING id`,
      [`GATE-${sequence}`, `Pneu portao ${sequence}`],
    );
    await db.pool.query(
      `INSERT INTO commerce.tire_specs
         (environment,product_id,tire_size,width_mm,aspect_ratio,rim_diameter)
       VALUES ('test',$1,$2,$3,$4,$5)`,
      [product.rows[0]!.id, measure, 220 + sequence, 40 + sequence, 13 + sequence],
    );
    const supplier = await registerSupplier({
      environment: 'test',
      name: `Fornecedor portao ${sequence}`,
      phone: `2197${String(sequence).padStart(6, '0')}`,
    }, db.pool);
    await registerPurchase({
      environment: 'test',
      supplier_id: supplier.id,
      items: [{ measure, quantity: 4, unit_cost: 25 }],
      purchased_at: month === '2026-06'
        ? '2026-07-01T01:30:00Z'
        : `${day}T12:00:00Z`,
      payment_status: 'paid',
      receipt_status: 'received',
      created_by: 'owner:gate',
      idempotency_key: randomUUID(),
    }, db.pool);
    await registerSale({
      environment: 'test',
      new_customer: { name: `Cliente portao ${sequence}` },
      items: [{ measure, quantity: 1, unit_price: 60 }],
      sold_at: `${month}-10T12:00:00Z`,
      payment_status: 'paid',
      created_by: 'owner:gate',
      idempotency_key: randomUUID(),
    }, db.pool);

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await insertExpense(client, {
        environment: 'test',
        category: 'frete',
        description: `Frete portao ${sequence}`,
        amount: 10,
        payment_status: 'paid',
        paid_at: `${month}-12T12:00:00Z`,
        occurred_at: `${month}-12T12:00:00Z`,
        document_date: `${month}-12`,
        competence_month: `${month}-01`,
        created_by: 'owner:gate',
      });
      const run = await client.query<{ id: string }>(
        `INSERT INTO marketing.meta_sync_runs
           (environment,trigger_type,window_since,window_until,status,finished_at)
         VALUES ('test','manual',$1,$1,'succeeded',now()) RETURNING id`,
        [`${month}-15`],
      );
      const insight = await client.query<{ id: string }>(
        `INSERT INTO marketing.meta_insights_daily
           (environment,sync_run_id,ad_account_id,api_version,account_currency,
            entity_level,entity_id,campaign_id,metric_date,spend)
         VALUES ('test',$1,$2,'v21.0','BRL','campaign',$3,$3,$4,5)
         RETURNING id`,
        [run.rows[0]!.id, `act_gate_${sequence}`, `camp_gate_${sequence}`, `${month}-15`],
      );
      await reconcileMarketing(client, insight.rows[0]!.id, run.rows[0]!.id);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  it('fecha duas competencias e detecta/repara uma origem sem ledger', async () => {
    await seedCompetence('2026-06');
    await seedCompetence('2026-07');

    const client = await db.pool.connect();
    let removedExpenseId: string;
    try {
      await client.query('BEGIN');
      const removable = await insertExpense(client, {
        environment: 'test',
        category: 'combustivel',
        description: 'Despesa removida no gate',
        amount: 2,
        payment_status: 'paid',
        paid_at: '2026-07-18T12:00:00Z',
        occurred_at: '2026-07-18T12:00:00Z',
        document_date: '2026-07-18',
        competence_month: '2026-07-01',
        created_by: 'owner:gate',
      });
      removedExpenseId = removable.id;
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    await removeExpense(removedExpenseId!, 'test', db.pool, {
      actor_label: 'owner:gate',
      reason: 'Prova de estorno no portao',
      idempotency_key: randomUUID(),
    });

    const green = await getGate(['2026-06-01', '2026-07-01'], 'test', db.pool);
    expect(green).toMatchObject({
      status: 'green',
      required_competences: 2,
      checked_competences: 2,
      total_abs_difference: '0.00',
    });
    expect(green.competences.every((item) =>
      item.origins.length === 8 && item.origins.every((origin) => origin.matched))).toBe(true);
    expect(green.competences.map((item) => item.origins.filter(
      (origin) => Number(origin.source_total) > 0,
    ).map((origin) => origin.origin))).toEqual([
      ['atacado', 'compras', 'despesas', 'marketing'],
      ['atacado', 'compras', 'despesas', 'marketing'],
    ]);

    const missing = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.matriz_expenses
         (environment,category,description,amount,payment_status,paid_at,
          occurred_at,document_date,competence_month,created_by)
         VALUES ('test','frete','Furo controlado',1,'paid',
               '2026-06-20T12:00:00Z','2026-06-20T12:00:00Z',
               '2026-06-20','2026-06-01','test:gate')
       RETURNING id`,
    );
    const red = await getGate(['2026-06-01', '2026-07-01'], 'test', db.pool);
    expect(red.status).toBe('red');
    expect(red.competences[0]!.origins.find(
      (origin) => origin.origin === 'despesas',
    )).toMatchObject({ difference: '1.00', matched: false });

    const repairClient = await db.pool.connect();
    try {
      const { ensureMatrizExpenseAccrual, getMatrizExpenseLedgerState }
        = await import('../../src/admin/painel/matriz-ledger-expenses.js');
      await ensureMatrizExpenseAccrual(repairClient,
        await getMatrizExpenseLedgerState(repairClient, 'test', missing.rows[0]!.id));
    } finally {
      repairClient.release();
    }
    expect(await getGate(
      ['2026-06-01', '2026-07-01'], 'test', db.pool,
    )).toMatchObject({ status: 'green', total_abs_difference: '0.00' });
  });

  it('expoe o portao somente ao dono e valida a consulta', async () => {
    const { default: Fastify } = await import('fastify');
    const { registerPainelIntegrity } =
      await import('../../src/admin/painel/route-integrity.js');
    const app = Fastify();
    await registerPainelIntegrity(app);
    const url = '/admin/api/integrity/matriz-ledger/competences'
      + '?competences=2026-06-01,2026-07-01';
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    expect((await app.inject({
      method: 'GET',
      url: '/admin/api/integrity/matriz-ledger/competences?competences=2026-06-01',
      headers: { authorization: 'Bearer emergency-token' },
    })).statusCode).toBe(400);
    const response = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: 'Bearer emergency-token' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'green',
      checked_competences: 2,
      total_abs_difference: '0.00',
    });
    await app.close();
  });
});
