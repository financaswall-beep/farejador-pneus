import { futureDueDate } from './helpers/business-dates.js';
// AUDITORIA 02/10/2026 - REGRESSAO (ja passa): operacao inteira encadeada.
// Mover para tests/integration/ JUNTO com o conserto do item (ver docs/PLANO_CORRECOES_AUDITORIA_2026-10-02.md).
// compra a prazo -> recebe 3 de 4 -> custo medio -> venda com entrega + vendedor ->
// rota do entregador -> entregue (pix) -> folha de setembro fechada e paga ->
// cancela em outubro -> estoque, livro, estorno causal da folha, saude e agenda.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('auditoria: cadeia completa comprar -> receber -> vender -> entregar -> folha -> cancelar', () => {
  let db: IntegrationDb;
  beforeAll(async () => {
    Object.assign(process.env, { NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
      CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'emergency-token',
      WHOLESALE_FINANCE: 'true', WHOLESALE_MATRIZ_RETAIL_COST: 'true', MATRIZ_EXPENSES: 'true',
      MATRIZ_CENTRAL_LEDGER: 'true', MATRIZ_CENTRAL_LEDGER_READ: 'true' });
    db = await startPostgres();
    process.env.DATABASE_URL = db.connectionString;
    await db.pool.query(`INSERT INTO core.units (environment, slug, name, is_active)
      VALUES ('test','main','Matriz',true) ON CONFLICT (environment, slug) DO UPDATE SET is_active=true`);
  }, 240_000);
  afterAll(async () => { if (db) await stopPostgres(db); });

  const q = async (sql: string, params: unknown[] = []) => (await db.pool.query(sql, params)).rows;
  async function stock(measure: string) {
    return (await q(`SELECT quantity_on_hand,quantity_reserved,unit_cost::text FROM commerce.wholesale_stock
      WHERE environment='test' AND measure=$1`, [measure]))[0];
  }
  async function accounts(where: string, params: unknown[]) {
    const rows = await q(`SELECT e.account_code,
        sum(CASE e.side WHEN 'debit' THEN e.amount ELSE -e.amount END)::numeric(14,2)::text net
      FROM finance.matriz_ledger_transactions t JOIN finance.matriz_ledger_entries e ON e.transaction_id=t.id
      WHERE t.environment='test' AND (${where}) GROUP BY e.account_code ORDER BY 1`, params);
    return Object.fromEntries(rows.map((x: { account_code: string; net: string }) => [x.account_code, x.net]));
  }

  it('fecha a cadeia sem fantasma', async () => {
    const measure = '205/55-16';
    const product = (await q(`INSERT INTO commerce.products (environment,product_code,product_name,product_type,brand,tire_condition)
      VALUES ('test','AUD-CADEIA','Pneu 205/55-16','tire','Sem marca','meia_vida') RETURNING id`))[0].id;
    await q(`INSERT INTO commerce.tire_specs (environment,product_id,tire_size,width_mm,aspect_ratio,rim_diameter)
      VALUES ('test',$1,$2,205,55,16)`, [product, measure]);
    await q(`INSERT INTO commerce.matriz_product_prices (environment,product_id,price_amount,currency,valid_from)
      VALUES ('test',$1,120,'BRL','2026-01-01T00:00:00Z')`, [product]);

    // Equipe: vendedor 10% da margem + salario 1000; entregador R$8 por entrega + salario 800.
    const payroll = await import('../../src/admin/painel/queries-colaboradores-folha.js');
    async function collaborator(username: string, name: string, job: string) {
      const person = (await q(`INSERT INTO network.partner_people (environment,username) VALUES ('test',$1) RETURNING id`, [username]))[0].id;
      return (await q(`INSERT INTO network.matriz_collaborators (environment,person_id,display_name,job,job_title,work_area,created_at)
        VALUES ('test',$1,$2,$3,$3,$4,'2026-08-01T12:00:00Z') RETURNING id`,
        [person, name, job, job === 'vendedor' ? 'sales' : 'delivery']))[0].id as string;
    }
    const seller = await collaborator('vendedor.aud', 'Vendedor Auditoria', 'vendedor');
    const courier = await collaborator('entregador.aud', 'Entregador Auditoria', 'entregador');
    for (const [id, salary] of [[seller, 1000], [courier, 800]] as const) {
      await payroll.saveMatrizCollaboratorCompensation({ collaborator_id: id, employment_type: 'clt', base_salary: salary,
        payment_day: 5, payment_method: 'pix', starts_on: '2026-08-01', environment: 'test', actor_label: 'owner:aud' }, db.pool);
    }
    await payroll.saveMatrizCollaboratorCommission({ collaborator_id: seller, kind: 'percent', basis: 'margin', value: 10,
      starts_on: '2026-08-01', environment: 'test', actor_label: 'owner:aud' }, db.pool);
    await payroll.saveMatrizCollaboratorCommission({ collaborator_id: courier, kind: 'fixed', basis: 'delivery', value: 8,
      starts_on: '2026-08-01', environment: 'test', actor_label: 'owner:aud' }, db.pool);

    // 1) Compra a vista recebida: 2 x R$40.
    const { registerWholesaleSupplier } = await import('../../src/admin/painel/queries-fornecedores.js');
    const purchases = await import('../../src/admin/painel/queries-fornecedores-registro.js');
    const supplier = await registerWholesaleSupplier({ environment: 'test', name: 'Fornecedor Cadeia', phone: '21970001111' } as never, db.pool);
    await purchases.registerWholesalePurchase({ environment: 'test', supplier_id: supplier.id,
      items: [{ measure, quantity: 2, unit_cost: 40 }], purchased_at: '2026-09-01T12:00:00Z',
      payment_status: 'paid', receipt_status: 'received', created_by: 'owner:aud', idempotency_key: randomUUID() } as never, db.pool);
    const s1 = await stock(measure);

    // 2) Compra a prazo 4 x R$50, chega so 3.
    const p2 = await purchases.registerWholesalePurchase({ environment: 'test', supplier_id: supplier.id,
      items: [{ measure, quantity: 4, unit_cost: 50 }], purchased_at: '2026-09-02T12:00:00Z',
      payment_status: 'pending', due_date: futureDueDate(), receipt_status: 'pending',
      created_by: 'owner:aud', idempotency_key: randomUUID() } as never, db.pool);
    const item = (await q(`SELECT id FROM commerce.wholesale_purchase_items WHERE environment='test' AND purchase_id=$1`, [p2.purchase_id]))[0].id;
    const confirmKey = randomUUID();
    await purchases.confirmWholesalePurchase({ purchase_id: p2.purchase_id, confirmed_by: 'owner:aud', environment: 'test',
      idempotency_key: confirmKey, items: [{ item_id: item, accepted_quantity: 3 }] }, db.pool);
    const replay = await purchases.confirmWholesalePurchase({ purchase_id: p2.purchase_id, confirmed_by: 'owner:aud', environment: 'test',
      idempotency_key: confirmKey, items: [{ item_id: item, accepted_quantity: 3 }] }, db.pool).then(() => 'replay ok', (e: Error) => e.message);
    const s2 = await stock(measure);
    const purchaseRow = (await q(`SELECT total_amount::text,payment_status FROM commerce.wholesale_purchases WHERE id=$1`, [p2.purchase_id]))[0];
    const accrual = (await q(`SELECT id FROM finance.matriz_ledger_transactions WHERE environment='test'
      AND source_type='commerce.wholesale_purchase.accrual' AND source_id=$1`, [p2.purchase_id]))[0].id;
    const apBalance = (await q(`SELECT finance.matriz_ledger_obligation_balance('test',$1)::text b`, [accrual]))[0].b;
    console.log('COMPRA 1 (2x40):', JSON.stringify(s1), '| COMPRA 2 recebe 3 de 4:', JSON.stringify(s2),
      '| compra:', JSON.stringify(purchaseRow), '| saldo a pagar:', apBalance, '| replay do recebimento:', replay);

    // 3) Venda de 2 pneus com entrega, vendedor marcado, preco de tabela R$120.
    const { registerWalkinOrder, cancelManualOrder } = await import('../../src/admin/painel/queries-pedidos-acoes.js');
    const saleKey = randomUUID();
    const saleInput = { environment: 'test', customer_name: 'Cliente Cadeia', customer_phone: '21988887777', unit_id: null,
      items: [{ product_id: product, quantity: 2, unit_price: 120 }], payment_method: 'pix',
      fulfillment_mode: 'delivery', delivery_address: 'Rua da Auditoria, 10', actor_label: 'owner:aud',
      seller_collaborator_id: seller, idempotency_key: saleKey, source_tag: 'walkin_balcao' } as never;
    const { order_id } = await registerWalkinOrder(saleInput, db.pool);
    const again = await registerWalkinOrder(saleInput, db.pool);
    const s3 = await stock(measure);
    const cost = (await q(`SELECT matriz_unit_cost::text FROM commerce.order_items WHERE order_id=$1`, [order_id]))[0].matriz_unit_cost;
    const ledgerBeforeDelivery = await accounts(`t.source_id=$1`, [order_id]);
    console.log('VENDA:', order_id === again.order_id ? 'replay devolve o mesmo pedido' : 'REPLAY CRIOU OUTRO PEDIDO',
      '| estoque:', JSON.stringify(s3), '| custo congelado:', cost, '| livro antes da entrega:', JSON.stringify(ledgerBeforeDelivery));

    // 4) Rota + entregue com pix.
    const rotas = await import('../../src/admin/painel/queries-logistica-rotas.js');
    const logistica = await import('../../src/admin/painel/queries-logistica.js');
    const trip = await rotas.openMatrizTrip({ courier_collaborator_id: courier, km_start: 1000, order_ids: [order_id], environment: 'test' }, db.pool);
    await logistica.setMatrizDeliveryStatus({ order_id, status: 'delivered', courier: 'Entregador Auditoria', payment_method: 'pix', environment: 'test' }, db.pool);
    const twice = await logistica.setMatrizDeliveryStatus({ order_id, status: 'delivered', courier: 'Entregador Auditoria', payment_method: 'pix', environment: 'test' }, db.pool)
      .then(() => 'segunda confirmacao aceita', (e: Error) => `segunda confirmacao recusada: ${e.message}`);
    await rotas.closeMatrizTrip({ trip_id: trip.trip_id, km_end: 1030, fuel_spent: null, environment: 'test', actor_label: 'owner:aud' }, db.pool);
    const ledgerDelivered = await accounts(`t.source_id=$1`, [order_id]);
    console.log('ENTREGUE:', twice, '| livro:', JSON.stringify(ledgerDelivered));

    // A venda e a entrega aconteceram em setembro (data de negocio); folha de setembro fecha e paga.
    await q(`UPDATE commerce.orders SET created_at='2026-09-20T15:00:00Z', delivered_at='2026-09-21T15:00:00Z' WHERE id=$1`, [order_id]);
    const closed = await payroll.closeMatrizPayroll({ competence: '2026-09-01', environment: 'test', actor_label: 'owner:aud' }, db.pool);
    const items = await q(`SELECT i.id,mc.display_name,i.base_salary::text,i.commission_amount::text,i.total_due::text
      FROM finance.matriz_payroll_items i JOIN network.matriz_collaborators mc ON mc.id=i.collaborator_id
      WHERE i.payroll_period_id=$1 ORDER BY mc.display_name`, [closed.period_id]);
    for (const row of items) {
      await payroll.payMatrizPayrollItem({ item_id: row.id, environment: 'test', actor_label: 'owner:aud', idempotency_key: randomUUID() }, db.pool);
    }
    console.log('FOLHA SETEMBRO:', JSON.stringify(items.map((r: Record<string, string>) => [r.display_name, r.base_salary, r.commission_amount, r.total_due])));

    // 5) Cliente devolve em outubro: cancela.
    await cancelManualOrder({ order_id, actor_label: 'owner:aud', reason: 'cliente devolveu', environment: 'test' } as never, db.pool);
    const s4 = await stock(measure);
    const ledgerCancelled = await accounts(`t.source_id=$1`, [order_id]);
    const causal = await q(`SELECT mc.display_name,a.competence::text,a.amount::text,a.causal_status,a.description
      FROM finance.matriz_payroll_adjustments a JOIN network.matriz_collaborators mc ON mc.id=a.collaborator_id
      WHERE a.environment='test' ORDER BY mc.display_name`);
    console.log('CANCELADO: estoque', JSON.stringify(s4), '| livro:', JSON.stringify(ledgerCancelled));
    console.log('ESTORNO CAUSAL NA FOLHA:', JSON.stringify(causal));

    const agendaModule = await import('../../src/admin/painel/matriz-ledger-open-items.js');
    const agenda = await agendaModule.getMatrizLedgerOpenItems('test', db.pool);
    console.log('AGENDA a pagar:', agenda.a_pagar.total, JSON.stringify(agenda.a_pagar.itens.map((i: Record<string, unknown>) => [i.tipo, i.valor ?? i.amount ?? i.saldo])));
    const healthModule = await import('../../src/admin/painel/matriz-ledger-integration-health.js');
    await healthModule.runMatrizLedgerIntegrationBackfill({ environment: 'test', limit: 1_000 }, db.pool);
    const health = await healthModule.getMatrizLedgerIntegrationHealth('test', db.pool);
    expect(health.status).toBe('green');
    expect(health.global.total_error_signals).toBe(0);
    console.log('SAUDE:', health.status, 'sinais de erro:', health.global.total_error_signals);
    const galpaoValue = (await q(`SELECT (sum(quantity_on_hand*unit_cost))::numeric(14,2)::text v FROM commerce.wholesale_stock WHERE environment='test'`))[0].v;
    const ledgerInventory = (await accounts(`true`, [])).inventory;
    console.log('GALPAO valor fisico:', galpaoValue, '| livro conta estoque:', ledgerInventory);

    expect.soft(s1).toMatchObject({ quantity_on_hand: 2, unit_cost: '40.000000' });
    expect.soft(s2).toMatchObject({ quantity_on_hand: 5, unit_cost: '46.000000' });
    expect.soft(purchaseRow.total_amount).toBe('150.00');
    expect.soft(apBalance).toBe('150.00');
    expect.soft(order_id).toBe(again.order_id);
    expect.soft(s3).toMatchObject({ quantity_on_hand: 3 });
    expect.soft(Number(cost)).toBe(46);
    expect.soft(items.map((r: Record<string, string>) => r.commission_amount).sort()).toEqual(['14.80', '8.00']);
    expect.soft(s4).toMatchObject({ quantity_on_hand: 5, unit_cost: '46.000000' });
    expect.soft(ledgerCancelled.customer_refund_payable).toBe('-240.00');
    expect.soft(causal.map((r: Record<string, string>) => r.amount).sort()).toEqual(['14.80', '8.00']);
    expect.soft(galpaoValue).toBe(ledgerInventory);
  });
});
