import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPartnerFixture } from './helpers/partner-fixtures.js';
import {
  buildRestrictedConnectionString, startPostgres, stopPostgres, type IntegrationDb,
} from './helpers/postgres.js';

describe('Etapa 8 — fluxo financeiro central ponta a ponta', () => {
  let db: IntegrationDb;

  beforeAll(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test',
      FAREJADOR_ENV: 'test',
      DATABASE_URL: 'postgres://test',
      CHATWOOT_HMAC_SECRET: 'test-secret',
      ADMIN_AUTH_TOKEN: 'emergency-token',
      ADMIN_BEARER_FALLBACK_ENABLED: 'true',
      WHOLESALE_FINANCE: 'true',
      WHOLESALE_MATRIZ_RETAIL_COST: 'true',
      MATRIZ_EXPENSES: 'true',
      NETWORK_COMMISSION_LEDGER: 'true',
      MATRIZ_CENTRAL_LEDGER: 'true',
      MATRIZ_CENTRAL_LEDGER_READ: 'true',
    });
    vi.resetModules();
    db = await startPostgres();
    process.env.DATABASE_URL = db.connectionString;
    process.env.PARTNER_DATABASE_URL =
      buildRestrictedConnectionString(db.connectionString);
    vi.resetModules();
  }, 180_000);

  afterAll(async () => {
    const { partnerPool } = await import('../../src/parceiro/db.js');
    await partnerPool.end();
    if (db) await stopPostgres(db);
    delete process.env.PARTNER_DATABASE_URL;
    process.env.MATRIZ_CENTRAL_LEDGER = 'false';
    process.env.MATRIZ_CENTRAL_LEDGER_READ = 'false';
    vi.resetModules();
  });

  it('encerra a cadeia operacional sem saldo fantasma nem divergencia', async () => {
    const suppliers = await import('../../src/admin/painel/queries-fornecedores.js');
    const purchases = await import(
      '../../src/admin/painel/queries-fornecedores-registro.js'
    );
    const sales = await import('../../src/admin/painel/queries-atacado-vendas.js');
    const cancelSales = await import(
      '../../src/admin/painel/queries-atacado-cancelar.js'
    );
    const finance = await import(
      '../../src/admin/painel/queries-financeiro-integridade.js'
    );
    const payroll = await import(
      '../../src/admin/painel/queries-colaboradores-folha.js'
    );
    const partner = await import('../../src/parceiro/queries.js');
    const admin = await import('../../src/admin/painel/queries.js');
    const marketing = await import('../../src/marketing/matriz-ledger-spend.js');
    const agendaModule = await import(
      '../../src/admin/painel/matriz-ledger-open-items.js'
    );
    const settlement = await import(
      '../../src/admin/painel/matriz-ledger-settlement.js'
    );

    const person = await db.pool.query<{ id: string }>(
      `INSERT INTO network.partner_people (environment,username)
       VALUES ('test','vendedor.e2e') RETURNING id`,
    );
    const collaborator = await db.pool.query<{ id: string }>(
      `INSERT INTO network.matriz_collaborators
         (environment,person_id,display_name,job,job_title,work_area,created_at)
       VALUES ('test',$1,'Vendedor E2E','vendedor','Vendedor','sales',
               '2026-07-01T12:00:00Z') RETURNING id`,
      [person.rows[0]!.id],
    );
    await payroll.saveMatrizCollaboratorCompensation({
      collaborator_id: collaborator.rows[0]!.id,
      employment_type: 'clt',
      base_salary: 100,
      payment_day: 5,
      payment_method: 'pix',
      starts_on: '2026-07-01',
      environment: 'test',
      actor_label: 'owner:e2e',
    }, db.pool);
    await payroll.saveMatrizCollaboratorCommission({
      collaborator_id: collaborator.rows[0]!.id,
      kind: 'fixed',
      basis: 'sale',
      value: 12,
      starts_on: '2026-07-01',
      environment: 'test',
      actor_label: 'owner:e2e',
    }, db.pool);

    const product = await db.pool.query<{ id: string }>(
      `INSERT INTO commerce.products
         (environment,product_code,product_name,product_type)
       VALUES ('test','E2E-PNEU','Pneu E2E','tire') RETURNING id`,
    );
    await db.pool.query(
      `INSERT INTO commerce.tire_specs
         (environment,product_id,tire_size,width_mm,aspect_ratio,rim_diameter)
       VALUES ('test',$1,'225/45-17',225,45,17)`,
      [product.rows[0]!.id],
    );
    const supplier = await suppliers.registerWholesaleSupplier({
      environment: 'test',
      name: 'Fornecedor E2E',
      phone: '21970000001',
    }, db.pool);
    const purchase = await purchases.registerWholesalePurchase({
      environment: 'test',
      supplier_id: supplier.id,
      items: [{ measure: '225/45-17', quantity: 4, unit_cost: 25 }],
      purchased_at: '2026-07-03T12:00:00Z',
      payment_status: 'paid',
      receipt_status: 'received',
      created_by: 'owner:e2e',
      idempotency_key: randomUUID(),
    }, db.pool);
    expect(purchase.total_amount).toBe('100.00');

    const sale = await sales.registerWholesaleSale({
      environment: 'test',
      new_customer: { name: 'Cliente E2E' },
      items: [{ measure: '225/45-17', quantity: 1, unit_price: 80 }],
      sold_at: '2026-07-10T12:00:00Z',
      payment_status: 'pending',
      due_date: '2026-07-20',
      created_by: 'owner:e2e',
      seller_collaborator_id: collaborator.rows[0]!.id,
      idempotency_key: randomUUID(),
    }, db.pool);
    await db.pool.query(
      `UPDATE commerce.wholesale_orders
          SET created_at='2026-07-10T12:00:00Z' WHERE id=$1`,
      [sale.order_id],
    );
    await finance.settleWholesaleOrderPayment(
      sale.order_id,
      'test',
      db.pool,
      { actor_label: 'owner:e2e', idempotency_key: randomUUID() },
    );

    const expense = await finance.createMatrizExpense({
      environment: 'test',
      category: 'frete',
      description: 'Entrega E2E',
      amount: 15,
      payment_status: 'pending',
      due_date: '2026-07-20',
      created_by: 'owner:e2e',
      idempotency_key: randomUUID(),
    }, db.pool);
    await finance.settleMatrizExpense(
      expense.id,
      'test',
      db.pool,
      { actor_label: 'owner:e2e', idempotency_key: randomUUID() },
    );

    const metaClient = await db.pool.connect();
    try {
      await metaClient.query('BEGIN');
      const run = await metaClient.query<{ id: string }>(
        `INSERT INTO marketing.meta_sync_runs
           (environment,trigger_type,window_since,window_until,status)
         VALUES ('test','manual','2026-07-15','2026-07-15','succeeded')
         RETURNING id`,
      );
      const insight = await metaClient.query<{ id: string }>(
        `INSERT INTO marketing.meta_insights_daily
           (environment,sync_run_id,ad_account_id,api_version,account_currency,
            entity_level,entity_id,campaign_id,metric_date,spend)
         VALUES ('test',$1,'act_e2e','v21.0','BRL','campaign',
                 'camp_e2e','camp_e2e','2026-07-15',9)
         RETURNING id`,
        [run.rows[0]!.id],
      );
      await marketing.reconcileMatrizMarketingSpend(
        metaClient,
        insight.rows[0]!.id,
        run.rows[0]!.id,
      );
      await metaClient.query('COMMIT');
    } catch (error) {
      await metaClient.query('ROLLBACK');
      throw error;
    } finally {
      metaClient.release();
    }

    const network = await createPartnerFixture(db.pool, {
      slugSuffix: 'ledger-e2e',
      initialStockQty: 3,
    });
    await db.pool.query(
      `UPDATE network.partners
          SET commercial_model='hybrid',commission_percent=10,monthly_fee=30
        WHERE id=$1`,
      [network.partnerId],
    );
    const partnerSale = await partner.registerPartnerSale(network.ctx, {
      customer_name: 'Cliente Rede E2E',
      customer_phone: null,
      items: [{
        partner_stock_id: network.stockId,
        quantity: 1,
        unit_price: 200,
      }],
      payment_method: 'pix',
      fulfillment_mode: 'delivery',
      delivery_address: 'Rua E2E, 10',
      source_tag: '2w',
      idempotency_key: randomUUID(),
    }, db.pool);
    await partner.updatePartnerDeliveryStatus(network.ctx, partnerSale.order_id, {
      delivery_status: 'delivered',
      payment_method: 'pix',
      delivery_courier: 'Entregador E2E',
    }, db.pool);
    await admin.sweepCommissionEntries('test', db.pool);
    await admin.settleCommissionEntries({
      partner_id: network.partnerId,
      settled_by: 'owner:e2e',
      idempotency_key: randomUUID(),
      reason: 'Comissao recebida E2E',
      environment: 'test',
    }, db.pool);
    const monthlyFee = (await admin.listMatrizPartnerMonthlyFees(
      'test',
      db.pool,
    )).find((item) => item.partner_id === network.partnerId);
    expect(monthlyFee).toBeTruthy();
    await admin.settleMatrizPartnerMonthlyFee({
      fee_id: monthlyFee!.id,
      actor_label: 'owner:e2e',
      idempotency_key: randomUUID(),
      environment: 'test',
    }, db.pool);

    const closed = await payroll.closeMatrizPayroll({
      competence: '2026-07-01',
      environment: 'test',
      actor_label: 'owner:e2e',
    }, db.pool);
    const payrollItem = await db.pool.query<{
      id: string;
      base_salary: string;
      commission_amount: string;
      total_due: string;
    }>(
      `SELECT id,base_salary::text,commission_amount::text,total_due::text
         FROM finance.matriz_payroll_items WHERE payroll_period_id=$1`,
      [closed.period_id],
    );
    expect(payrollItem.rows[0]).toMatchObject({
      base_salary: '100.00',
      commission_amount: '12.00',
      total_due: '112.00',
    });
    await payroll.payMatrizPayrollItem({
      item_id: payrollItem.rows[0]!.id,
      environment: 'test',
      actor_label: 'owner:e2e',
      idempotency_key: randomUUID(),
    }, db.pool);

    await cancelSales.cancelWholesaleSale({
      environment: 'test',
      order_id: sale.order_id,
      cancelled_by: 'owner:e2e',
      reason: 'Cancelamento pago E2E',
      idempotency_key: randomUUID(),
    }, db.pool);
    await partner.cancelPartnerSale(
      network.ctx,
      partnerSale.order_id,
      'Cancelamento apos recebimento E2E',
      db.pool,
    );
    await admin.sweepCommissionEntries('test', db.pool);
    const commissionRefund = await db.pool.query<{ id: string }>(
      `SELECT r.id
         FROM finance.matriz_commission_reversals r
         JOIN network.commission_entries e ON e.id=r.commission_entry_id
        WHERE e.partner_order_id=$1`,
      [partnerSale.order_id],
    );
    await admin.settleCommissionRefund({
      reversal_id: commissionRefund.rows[0]!.id,
      actor_label: 'owner:e2e',
      idempotency_key: randomUUID(),
      reason: 'Devolucao E2E',
      environment: 'test',
    }, db.pool);

    let agenda = await agendaModule.getMatrizLedgerOpenItems('test', db.pool);
    const customerRefund = agenda.a_pagar.itens.find((item) =>
      item.tipo === 'devolucao_cliente' && item.id === sale.order_id);
    expect(customerRefund).toBeTruthy();
    await settlement.settleMatrizLedgerOpenItem({
      obligation_id: customerRefund!.obligation_id!,
      idempotency_key: randomUUID(),
      actor_label: 'owner:e2e',
      environment: 'test',
    }, db.pool);
    await settlement.settleMatrizLedgerOpenItem({
      account_code: 'marketing_payable',
      idempotency_key: randomUUID(),
      actor_label: 'owner:e2e',
      environment: 'test',
    }, db.pool);

    const healthModule = await import(
      '../../src/admin/painel/matriz-ledger-integration-health.js'
    );
    await healthModule.runMatrizLedgerIntegrationBackfill({
      environment: 'test',
      limit: 1_000,
    }, db.pool);
    const health = await healthModule.getMatrizLedgerIntegrationHealth(
      'test',
      db.pool,
    );
    agenda = await agendaModule.getMatrizLedgerOpenItems('test', db.pool);
    const balance = await db.pool.query<{
      unbalanced: number;
      orphans: number;
      payments_without_allocation: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM (
            SELECT t.id,t.amount
              FROM finance.matriz_ledger_transactions t
              LEFT JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id
             WHERE t.environment='test'
             GROUP BY t.id,t.amount
            HAVING COALESCE(sum(e.amount) FILTER (WHERE e.side='debit'),0)<>t.amount
                OR COALESCE(sum(e.amount) FILTER (WHERE e.side='credit'),0)<>t.amount
          ) x) unbalanced,
         (SELECT count(*)::int
            FROM finance.matriz_ledger_entries e
            LEFT JOIN finance.matriz_ledger_transactions t
              ON t.id=e.transaction_id
           WHERE t.id IS NULL) orphans,
         (SELECT count(*)::int
            FROM finance.matriz_ledger_transactions t
           WHERE t.environment='test' AND t.transaction_kind='payment'
             AND NOT EXISTS (
               SELECT 1 FROM finance.matriz_ledger_payments p
                WHERE p.payment_transaction_id=t.id
             )) payments_without_allocation`,
    );
    expect(health.status).toBe('green');
    expect(health.global.total_error_signals).toBe(0);
    expect(balance.rows[0]).toEqual({
      unbalanced: 0,
      orphans: 0,
      payments_without_allocation: 0,
    });
    expect(agenda).toMatchObject({
      a_receber: { total: '0.00', itens: [] },
      a_pagar: { total: '0.00', itens: [] },
    });
  });
});
