import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres.js';

describe('transferências físicas lote ↔ estoque e perda na triagem', () => {
  let db: IntegrationDb;
  let service: typeof import('../../src/admin/painel/tire-stock-transfers.js');
  let purchase: typeof import('../../src/admin/painel/queries-fornecedores-registro.js').registerWholesalePurchase;
  let costs: typeof import('../../src/admin/painel/queries-stock-costs.js').getStockCosts;
  let supplier: string, product: string;
  beforeAll(async () => {
    Object.assign(process.env, { NODE_ENV: 'test', FAREJADOR_ENV: 'test', DATABASE_URL: 'postgres://test',
      CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'test-token', LOG_LEVEL: 'error',
      WHOLESALE_FINANCE: 'true', MATRIZ_CENTRAL_LEDGER: 'true', MATRIZ_CENTRAL_LEDGER_READ: 'true' });
    vi.resetModules(); db = await startPostgres(); process.env.DATABASE_URL = db.connectionString; vi.resetModules();
    service = await import('../../src/admin/painel/tire-stock-transfers.js');
    ({ registerWholesalePurchase: purchase } = await import('../../src/admin/painel/queries-fornecedores-registro.js'));
    ({ getStockCosts: costs } = await import('../../src/admin/painel/queries-stock-costs.js'));
    supplier = (await db.pool.query(`INSERT INTO commerce.wholesale_suppliers(environment,name) VALUES ('test','Fornecedor triagem') RETURNING id`)).rows[0].id;
    product = (await db.pool.query(`INSERT INTO commerce.products(environment,product_code,product_name,product_type,brand,tire_condition)
      VALUES ('test','TRIAGEM','Pneu triagem','tire','Pirelli','meia_vida') RETURNING id`)).rows[0].id;
    await db.pool.query(`INSERT INTO commerce.tire_specs(environment,product_id,tire_size,width_mm,aspect_ratio,rim_diameter,vehicle_type)
      VALUES ('test',$1,'130/70-13',130,70,13,'motorcycle')`, [product]);
  }, 180000);
  afterAll(async () => { if (db) await stopPostgres(db); vi.resetModules(); });
  const lot = (quantity = 200, total_cost = 1000) => purchase({ environment: 'test', supplier_id: supplier,
    items: [], lot: { description: 'Triagem', quantity, total_cost, vehicle_type: 'motorcycle' },
    payment_status: 'paid', payment_method: 'Pix', receipt_status: 'received',
    created_by: 'owner:test', idempotency_key: randomUUID() }, db.pool);
  const input = (id: string, quantity = 20) => ({ kind: 'to_stock' as const, lot_id: id,
    items: [{ product_id: product, quantity }], reason: 'Pneus identificados na triagem' });
  async function transfer(body: any) {
    const preview = await service.previewTireTransfer(body, db.pool);
    const key = randomUUID();
    return { preview, key, result: await service.confirmTireTransfer(body, preview.fingerprint, key, 'owner:test', db.pool) };
  }
  const stock = async () => (await db.pool.query(`SELECT * FROM commerce.wholesale_stock WHERE environment='test'
    AND measure='130/70-13' AND brand='Pirelli' AND tire_condition='meia_vida'`)).rows[0];
  async function totals() { return (await costs(db.pool)).summary; }
  it('desmembra parcialmente, conserva custo/quantidade, não cria compra/caixa e permite estorno', async () => {
    const p = await lot(); const body = input(p.lot_id!); const before = await totals();
    const ledger = (await db.pool.query('SELECT count(*)::int n FROM finance.matriz_ledger_transactions')).rows[0].n;
    const { result, preview, key } = await transfer(body);
    expect(result.cost).toBe('100.00'); expect(preview.remaining_quantity).toBe(180);
    expect((await totals()).capital).toBe(before.capital); expect((await totals()).quantity).toBe(before.quantity);
    expect((await stock()).quantity_on_hand).toBe(20);
    expect((await db.pool.query('SELECT count(*)::int n FROM finance.matriz_ledger_transactions')).rows[0].n).toBe(ledger);
    expect(await service.confirmTireTransfer(body, preview.fingerprint, key, 'owner:test', db.pool)).toEqual(result);
    const reversal = { id: result.id, reason: 'Identificação informada incorretamente', idempotency_key: randomUUID() };
    const reversed = await service.reverseTireTransfer(reversal, 'owner:test', db.pool);
    expect(await service.reverseTireTransfer(reversal, 'owner:test', db.pool)).toEqual(reversed);
    expect((await stock()).quantity_on_hand).toBe(0); expect(await totals()).toEqual(before);
  });
  it('usa custo médio do destino e mantém todos os centavos em três transferências', async () => {
    const p = await lot(3, 100); const before = await totals();
    for (let n = 0; n < 3; n++) await transfer(input(p.lot_id!, 1));
    expect((await totals()).capital).toBe(before.capital); expect((await totals()).quantity).toBe(before.quantity);
    expect(Number((await stock()).unit_cost)).toBeCloseTo(33.333333, 6);
    expect((await db.pool.query('SELECT remaining_cost::text,quantity_on_hand FROM commerce.tire_lots WHERE id=$1', [p.lot_id])).rows[0]).toEqual({ remaining_cost: '0.00', quantity_on_hand: 0 });
  });
  it('recusa prévia vencida, reserva, quantidade acima do lote e outro ambiente', async () => {
    const p = await lot(); const body = input(p.lot_id!); const preview = await service.previewTireTransfer(body, db.pool);
    await db.pool.query('UPDATE commerce.tire_lots SET quantity_reserved=190 WHERE id=$1', [p.lot_id]);
    await expect(service.confirmTireTransfer(body, preview.fingerprint, randomUUID(), 'owner:test', db.pool)).rejects.toThrow('transfer_lot_insufficient');
    await db.pool.query('UPDATE commerce.tire_lots SET quantity_reserved=0 WHERE id=$1', [p.lot_id]);
    await expect(service.confirmTireTransfer(body, preview.fingerprint, randomUUID(), 'owner:test', db.pool)).rejects.toThrow('transfer_preview_changed');
    const prod = await purchase({ environment: 'prod', supplier_id: (await db.pool.query(`INSERT INTO commerce.wholesale_suppliers(environment,name) VALUES ('prod','Prod') RETURNING id`)).rows[0].id,
      items: [], lot: { description: 'Produção isolada', quantity: 1, total_cost: 10 }, payment_status: 'paid',
      receipt_status: 'received', created_by: 'owner:test', idempotency_key: randomUUID() }, db.pool);
    await expect(service.previewTireTransfer(input(prod.lot_id!, 1), db.pool)).rejects.toThrow('transfer_lot_unavailable');
  });
  it('bloqueia estorno após movimentação mesmo se o saldo voltar ao valor anterior', async () => {
    const p = await lot(); const { result } = await transfer(input(p.lot_id!));
    const s = await stock();
    await db.pool.query('UPDATE commerce.wholesale_stock SET quantity_reserved=1 WHERE id=$1', [s.id]);
    await db.pool.query('UPDATE commerce.wholesale_stock SET quantity_reserved=0 WHERE id=$1', [s.id]);
    await expect(service.reverseTireTransfer({ id: result.id, reason: 'Conferência de estorno', idempotency_key: randomUUID() }, 'owner:test', db.pool)).rejects.toThrow('transfer_has_later_movements');
  });
  it('forma lote, preserva veículo/custo, registra ambos os lados e estorna sem caixa', async () => {
    const s = await stock(), before = await totals();
    const { result } = await transfer({ kind: 'to_lot', stock_id: s.id, quantity: 2, description: 'Lote agrupado', reason: 'Separação para venda no atacado' });
    expect((await totals()).capital).toBe(before.capital); expect((await totals()).quantity).toBe(before.quantity);
    expect((await db.pool.query('SELECT vehicle_type FROM commerce.tire_lots WHERE id=$1', [result.lot_id])).rows[0].vehicle_type).toBe('motorcycle');
    await service.reverseTireTransfer({ id: result.id, reason: 'Desfazer agrupamento conferido', idempotency_key: randomUUID() }, 'owner:test', db.pool);
    expect(await totals()).toEqual(before);
  });
  it('perda na triagem reduz ativo e resultado, nunca caixa, e o estorno preserva histórico', async () => {
    const p = await lot(), before = await totals();
    const { result } = await transfer({ kind: 'loss', lot_id: p.lot_id!, quantity: 10, reason: 'Pneus inutilizáveis na triagem' });
    expect((await totals()).capital).toBe(before.capital - 50); expect((await totals()).quantity).toBe(before.quantity - 10);
    const entries = await db.pool.query(`SELECT e.account_code,e.side,e.amount::text FROM finance.matriz_ledger_entries e
      JOIN finance.matriz_ledger_transactions t ON t.id=e.transaction_id
      JOIN finance.matriz_inventory_adjustments a ON a.id::text=t.source_id WHERE a.movement_ref=$1 ORDER BY e.line_no`, [result.id]);
    expect(entries.rows.map(r => r.account_code)).toEqual(['inventory_loss','inventory']);
    await service.reverseTireTransfer({ id: result.id, reason: 'Perda registrada indevidamente', idempotency_key: randomUUID() }, 'owner:test', db.pool);
    expect(await totals()).toEqual(before);
    const { getMatrizLedgerCompetenceGate: gate } = await import('../../src/admin/painel/matriz-ledger-competence-gate.js');
    const month = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date()).slice(0, 7) + '-01';
    const previous = new Date(month + 'T12:00:00Z'); previous.setUTCMonth(previous.getUTCMonth() - 1);
    const reconciled = await gate([previous.toISOString().slice(0, 10), month], 'test', db.pool);
    expect(reconciled.competences.find(c => c.competence === month)!.origins.find(r => r.origin === 'estoque')!.matched).toBe(true);
  });
  it('desmembra em várias medidas e mantém a rastreabilidade da compra e viagem', async () => {
    const p = await lot(3, 100), before = await totals();
    const second = (await db.pool.query(`INSERT INTO commerce.products(environment,product_code,product_name,product_type,brand,tire_condition)
      VALUES ('test','TRIAGEM-2','Outra medida','tire','Michelin','novo') RETURNING id`)).rows[0].id;
    await db.pool.query(`INSERT INTO commerce.tire_specs(environment,product_id,tire_size,width_mm,aspect_ratio,rim_diameter,vehicle_type)
      VALUES ('test',$1,'90/90-12',90,90,12,'motorcycle')`, [second]);
    const group = (await db.pool.query(`INSERT INTO commerce.wholesale_purchase_groups(environment,name,created_by)
      VALUES ('test','Viagem da triagem','owner:test') RETURNING id`)).rows[0].id;
    await db.pool.query(`INSERT INTO commerce.wholesale_purchase_group_purchases(environment,group_id,purchase_id,linked_by)
      VALUES ('test',$1,$2,'owner:test')`, [group, p.purchase_id]);
    const { result } = await transfer({ ...input(p.lot_id!, 1), items: [{ product_id: product, quantity: 1 }, { product_id: second, quantity: 2 }] });
    expect((await totals()).capital).toBe(before.capital); expect((await totals()).quantity).toBe(before.quantity);
    const { listTireTransfers: history } = await import('../../src/admin/painel/tire-transfer-read.js');
    const data = await history({ lot_id: p.lot_id! }, db.pool);
    expect(data.rows[0]).toMatchObject({ id: result.id, purchase_id: p.purchase_id, group_id: group });
    expect(data.rows[0].items).toHaveLength(2);
    for (const item of data.rows[0].items) {
      expect((await history({ stock_id: item.stock_id }, db.pool)).rows.some((r: any) => r.id === result.id)).toBe(true);
    }
  });
  it('serializa confirmações concorrentes, recusa variante repetida e grava sem perda de centavos', async () => {
    const p = await lot(), body = input(p.lot_id!), preview = await service.previewTireTransfer(body, db.pool);
    await expect(service.previewTireTransfer({ ...body, items: [body.items[0]!, body.items[0]!] }, db.pool)).rejects.toThrow('transfer_duplicate_variant');
    const results = await Promise.allSettled([service.confirmTireTransfer(body, preview.fingerprint, randomUUID(), 'owner:test', db.pool),
      service.confirmTireTransfer(body, preview.fingerprint, randomUUID(), 'owner:test', db.pool)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await db.pool.query('SELECT quantity_on_hand FROM commerce.tire_lots WHERE id=$1', [p.lot_id])).rows[0].quantity_on_hand).toBe(180);
  });
  it('venda congela o custo e impede estorno da transferência anterior', async () => {
    const p = await lot(), { result } = await transfer(input(p.lot_id!));
    const { registerLotSale: sell } = await import('../../src/admin/painel/register-lot-sale.js');
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const sale = await sell({ new_customer: { name: 'Borracharia da triagem' }, description: 'Pneus do lote', amount: 100,
      discount: 0, expected_cost: 50, sold_on: today, payment_status: 'paid', payment_method: 'Pix', notes: '',
      idempotency_key: randomUUID(), allocations: [{ lot_id: p.lot_id!, quantity: 10 }] }, 'owner:test', null, db.pool);
    const frozen = (await db.pool.query('SELECT unit_cost::text FROM commerce.wholesale_order_items WHERE order_id=$1', [sale.order_id])).rows;
    await transfer(input(p.lot_id!, 5));
    expect((await db.pool.query('SELECT unit_cost::text FROM commerce.wholesale_order_items WHERE order_id=$1', [sale.order_id])).rows).toEqual(frozen);
    await expect(service.reverseTireTransfer({ id: result.id, reason: 'Não pode após uma venda', idempotency_key: randomUUID() }, 'owner:test', db.pool)).rejects.toThrow('transfer_has_later_movements');
  });
  it('movimentos e transferências são imutáveis e o banco recusa lançamentos sem contrapartida', async () => {
    const p = await lot(), { result } = await transfer(input(p.lot_id!));
    await expect(db.pool.query('DELETE FROM commerce.tire_stock_transfers WHERE id=$1', [result.id])).rejects.toThrow('lot_movement_immutable');
    await expect(db.pool.query('UPDATE commerce.tire_stock_transfer_items SET cost=0 WHERE transfer_id=$1', [result.id])).rejects.toThrow('lot_movement_immutable');
    const row = (await db.pool.query('SELECT * FROM commerce.tire_stock_transfers WHERE id=$1', [result.id])).rows[0];
    await expect(db.pool.query(`INSERT INTO commerce.tire_stock_transfers
      (id,environment,kind,lot_id,quantity,cost,reason,created_by,before_lot,after_lot)
      VALUES ($1,'test','to_stock',$2,20,100,'Registro sem contrapartida','owner:test',$3::jsonb,$4::jsonb)`,
    [randomUUID(), p.lot_id, JSON.stringify(row.before_lot), JSON.stringify(row.after_lot)])).rejects.toThrow('transfer_items_do_not_close');
  });
  it('preserva a correção de marca com o mesmo ID, mas bloqueia exclusão e estorno antigo', async () => {
    const p = await lot(), { result } = await transfer(input(p.lot_id!));
    const before = await stock(), capital = (await totals()).capital;
    const { deleteWholesaleStockComRotulo: remove } = await import('../../src/admin/painel/queries-galpao-removal.js');
    await expect(remove({ environment: 'test', measure: before.measure, brand: before.brand, tire_condition: before.tire_condition,
      reason: 'Remoção solicitada incorretamente', idempotency_key: randomUUID(), actor_label: 'owner:test' }, db.pool)).rejects.toThrow('stock_has_transfer_history');
    const { correctWholesaleStockBrand: correct } = await import('../../src/admin/painel/queries-stock-brand-correction.js');
    const corrected = await correct({ environment: 'test', measure: before.measure, from_brand: before.brand,
      to_brand: 'Rinaldi', tire_condition: before.tire_condition, reason: 'Marca identificada corretamente',
      idempotency_key: randomUUID(), actor_label: 'owner:test' }, db.pool);
    expect(corrected.stock_id).toBe(before.id); expect((await totals()).capital).toBe(capital);
    const after = (await db.pool.query('SELECT inventory_revision FROM commerce.wholesale_stock WHERE id=$1', [before.id])).rows[0];
    expect(after.inventory_revision).not.toBe(before.inventory_revision);
    await expect(service.reverseTireTransfer({ id: result.id, reason: 'Tentativa após correção de marca',
      idempotency_key: randomUUID() }, 'owner:test', db.pool)).rejects.toThrow('transfer_has_later_movements');
  });
});
