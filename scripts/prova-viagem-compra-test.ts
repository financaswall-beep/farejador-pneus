import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

if (process.env.FAREJADOR_ENV !== 'test') throw Error('Esta prova exige FAREJADOR_ENV=test.');
process.env.WHOLESALE_FINANCE = 'true';
process.env.MATRIZ_CENTRAL_LEDGER = 'true';
const actor = 'prova-viagem-compra';
const key = () => randomUUID();

/** O teste inteiro fica no BEGIN/ROLLBACK externo; transações dos serviços
 * viram savepoints, preservando os mesmos caminhos de produção e de erro. */
function transactionalPool(client: PoolClient): Pool {
  let number = 0; const savepoints: string[] = [];
  const query = async (sql: any, params?: any) => {
    if (typeof sql === 'string' && /^BEGIN\b/i.test(sql.trim())) {
      const name = 'proof_' + ++number; savepoints.push(name); return client.query('SAVEPOINT ' + name);
    }
    if (typeof sql === 'string' && /^(COMMIT|ROLLBACK)$/i.test(sql.trim())) {
      const name = savepoints.pop(); if (!name) throw Error('proof_transaction_unbalanced');
      if (/ROLLBACK/i.test(sql)) await client.query('ROLLBACK TO SAVEPOINT ' + name);
      return client.query('RELEASE SAVEPOINT ' + name);
    }
    return client.query(sql, params);
  };
  return { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
}

async function main() {
  const { pool } = await import('../src/persistence/db.js');
  const { env } = await import('../src/shared/config/env.js');
  if (env.FAREJADOR_ENV !== 'test') throw Error('Esta prova exige environment=test.');
  const { createPurchaseGroup: create, changePurchaseGroup: change, linkPurchaseGroup: link } = await import('../src/admin/painel/queries-purchase-groups-write.js');
  const { getPurchaseGroup: read } = await import('../src/admin/painel/queries-purchase-groups.js');
  const { registerWholesalePurchase: register, confirmWholesalePurchase: receive } = await import('../src/admin/painel/queries-fornecedores-registro.js');
  const { listWholesalePurchases: list } = await import('../src/admin/painel/queries-fornecedores.js');
  const { cancelWholesalePurchase: cancel } = await import('../src/admin/painel/queries-fornecedores-cancel.js');
  const { createMatrizExpense: expense } = await import('../src/admin/painel/queries-financeiro-despesas-integridade.js');
  const { removeMatrizExpense: remove } = await import('../src/admin/painel/queries-financeiro-despesas-remove.js');
  const { purchaseGroupOwnedFixtures } = await import('./viagem-compra-owned-fixtures.js');
  const client = await pool.connect(), db = transactionalPool(client);
  let completed = 0;
  const check = async (name: string, work: () => Promise<void>) => { await work(); completed++; console.log(`[OK ${String(completed).padStart(2, '0')}/15] ${name}`); };
  const group = (name: string) => create({ environment: 'test', actor, name, idempotency_key: key() }, db);
  const bind = (group_id: string, kind: 'purchase' | 'expense', record_id: string, unlink = false) => link({ environment: 'test', actor, group_id, kind, record_id, unlink, idempotency_key: key() }, db);
  const snapshot = async () => {
    const tables = (await client.query<{ name: string }>(`SELECT schemaname||'.'||tablename name FROM pg_tables
      WHERE (schemaname='finance' AND tablename LIKE 'matriz_ledger_%') OR (schemaname='commerce'
      AND tablename IN ('wholesale_stock','wholesale_stock_movements','tire_lots','tire_lot_movements',
        'wholesale_purchases','wholesale_purchase_items','matriz_expenses')) ORDER BY 1`)).rows;
    const result: Record<string, string> = {};
    for (const t of tables) {
      const rows = (await client.query(`SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),'[]') data FROM ${t.name} x`)).rows[0].data;
      result[t.name] = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    }
    return result;
  };
  const rejects = async (work: () => Promise<unknown>, pattern: RegExp) => {
    await client.query('SAVEPOINT expected_error');
    let error: unknown;
    try { await work(); } catch (e) { error = e; }
    await client.query('ROLLBACK TO SAVEPOINT expected_error'); await client.query('RELEASE SAVEPOINT expected_error');
    assert(error instanceof Error, 'Esperava rejeição'); assert.match(error.message, pattern);
  };
  const before = await snapshot();
  try {
    await client.query('BEGIN');
    const supplier = (await db.query(`INSERT INTO commerce.wholesale_suppliers(environment,name) VALUES ('test',$1) RETURNING id`, ['Fornecedor VC ' + key()])).rows[0].id;
    const product = (await db.query(`INSERT INTO commerce.products(environment,product_code,product_name,product_type,brand,tire_condition)
      VALUES ('test',$1,'Pneu prova viagem','tire','Pirelli','novo') RETURNING id`, ['VC-' + key()])).rows[0].id;
    const measure = '296/98-28';
    await db.query(`INSERT INTO commerce.tire_specs(environment,product_id,tire_size,width_mm,aspect_ratio,rim_diameter)
      VALUES ('test',$1,$2,296,98,28)`, [product, measure]);
    const purchaseInput = () => ({ environment: 'test' as const, supplier_id: supplier, created_by: actor,
      receipt_status: 'pending' as const, payment_status: 'pending' as const, due_date: '2026-12-31',
      items: [{ measure, brand: 'Pirelli', tire_condition: 'novo' as const, vehicle_type: 'car' as const, quantity: 5, unit_cost: 25 }], idempotency_key: key() });
    let a: any, b: any, mainPurchase: any, avulsa: any, expenseA: any;
    let originalInput: ReturnType<typeof purchaseInput> & { group_id?: string };
    await check('VC único por ambiente e criação idempotente', async () => {
      const input = { environment: 'test' as const, actor, name: 'Viagem SP — prova', idempotency_key: key() };
      a = await create(input, db); b = await group('Outra viagem');
      assert.match(a.code, /^VC-\d{4,}$/); assert.notEqual(a.code, b.code); assert.deepEqual(await create(input, db), a);
    });
    await check('cadastro com viagem é atômico; compra avulsa permanece igual', async () => {
      originalInput = { ...purchaseInput(), group_id: a.id };
      mainPurchase = await register(originalInput, db); avulsa = await register(purchaseInput(), db);
      assert.equal((await db.query('SELECT group_id FROM commerce.wholesale_purchase_group_purchases WHERE purchase_id=$1', [mainPurchase.purchase_id])).rows[0].group_id, a.id);
      assert.equal((await db.query('SELECT 1 FROM commerce.wholesale_purchase_group_purchases WHERE purchase_id=$1', [avulsa.purchase_id])).rowCount, 0);
      const broken = { ...purchaseInput(), group_id: randomUUID() };
      const count = (await db.query('SELECT count(*) n FROM commerce.wholesale_purchases')).rows[0].n;
      await rejects(() => register(broken, db), /purchase_group_not_found/);
      assert.equal((await db.query('SELECT count(*) n FROM commerce.wholesale_purchases')).rows[0].n, count);
      const snap = await snapshot();
      await rejects(() => expense({ environment: 'test', group_id: randomUUID(), category: 'outros',
        amount: 2, created_by: actor, idempotency_key: key() }, db), /purchase_group_not_found/);
      assert.deepEqual(await snapshot(), snap, 'falha do vínculo reverte também a criação financeira da despesa');
    });
    await check('vincular/desvincular não muda UMA linha do financeiro, estoque ou origens', async () => {
      expenseA = await expense({ environment: 'test', category: 'outros', amount: 10, created_by: actor, idempotency_key: key() }, db);
      const physical = await register({ ...purchaseInput(), receipt_status: 'received' }, db);
      const physicalLot = await register({ ...purchaseInput(), items: [], receipt_status: 'received',
        lot: { description: 'Lote da prova de imutabilidade', quantity: 3, total_cost: 20 } }, db);
      const snap = await snapshot();
      await bind(a.id, 'purchase', avulsa.purchase_id); await bind(a.id, 'expense', expenseA.id);
      await bind(a.id, 'purchase', physical.purchase_id); await bind(a.id, 'purchase', physicalLot.purchase_id);
      assert.deepEqual(await snapshot(), snap);
      await bind(a.id, 'purchase', avulsa.purchase_id, true); await bind(a.id, 'expense', expenseA.id, true);
      await bind(a.id, 'purchase', physical.purchase_id, true); await bind(a.id, 'purchase', physicalLot.purchase_id, true);
      assert.deepEqual(await snapshot(), snap);
    });
    await check('compra e despesa não entram em duas viagens', async () => {
      await bind(a.id, 'purchase', avulsa.purchase_id); await bind(a.id, 'expense', expenseA.id);
      await rejects(() => bind(b.id, 'purchase', avulsa.purchase_id), /purchase_already_grouped/);
      await rejects(() => bind(b.id, 'expense', expenseA.id), /expense_already_grouped/);
    });
    await check('duas compras da mesma OC não se dividem', async () => {
      const sibling = await register({ ...purchaseInput(), purchase_order_id: mainPurchase.order_id }, db);
      await rejects(() => bind(b.id, 'purchase', sibling.purchase_id), /purchase_order_split_across_groups/);
      await bind(a.id, 'purchase', sibling.purchase_id);
    });
    await check('bloqueia gastos de combustível legado, nota da rota, nota perdida, folha e comissão', async () => {
      const ids = await purchaseGroupOwnedFixtures(db);
      assert.equal(ids.length, 5);
      for (const id of ids) await rejects(() => bind(a.id, 'expense', id), /expense_owned_by_other_module/);
    });
    let spending: any, paidExpense: any;
    await check('despesa paga e a pagar somam pelo valor da origem', async () => {
      spending = await group('Gastos da viagem');
      paidExpense = await expense({ environment: 'test', group_id: spending.id, category: 'outros', amount: 5.43, created_by: actor, idempotency_key: key() }, db);
      await expense({ environment: 'test', group_id: spending.id, category: 'outros', amount: 7.12, payment_status: 'pending', due_date: '2026-12-31', created_by: actor, idempotency_key: key() }, db);
      const data = await read(spending.id, 'test', db); assert.equal(data.summary.expenses, '12.55'); assert(!('paid' in data.summary));
    });
    await check('conferência acompanha os números da lista de Compras', async () => {
      const item = (await db.query('SELECT id FROM commerce.wholesale_purchase_items WHERE purchase_id=$1', [mainPurchase.purchase_id])).rows[0].id;
      await receive({ environment: 'test', purchase_id: mainPurchase.purchase_id, confirmed_by: actor, idempotency_key: key(), items: [{ item_id: item, accepted_quantity: 3 }] }, db);
      const origin = (await list('test', db, 200)).find(p => p.id === mainPurchase.purchase_id)!;
      const linked = (await read(a.id, 'test', db)).purchases.find(p => p.id === origin.id)!;
      assert.equal(linked.items_count, origin.items_count); assert.equal(linked.total_amount, origin.total_amount); assert.equal(linked.items_count, 3);
    });
    await check('lote usa valor e quantidade do lote, sem criar estoque por medida', async () => {
      const lot = await register({ ...purchaseInput(), items: [], group_id: a.id, lot: { description: 'Lote VC', quantity: 7, total_cost: 100.01 } }, db);
      const linked = (await read(a.id, 'test', db)).purchases.find(p => p.id === lot.purchase_id)!;
      assert.equal(linked.items_count, 7); assert.equal(linked.total_amount, '100.01'); assert.equal(linked.purchase_kind, 'lot');
    });
    await check('cancelada/removida sai da soma e mantém o vínculo visível', async () => {
      const p = await register({ ...purchaseInput(), group_id: spending.id }, db);
      await cancel({ environment: 'test', purchase_id: p.purchase_id, cancelled_by: actor, reason: 'Cancelamento na prova', idempotency_key: key() }, db);
      await remove(paidExpense.id, 'test', db, { reason: 'Remoção na prova', idempotency_key: key(), actor_label: actor });
      const data = await read(spending.id, 'test', db);
      assert.equal(data.summary.purchases, '0.00'); assert.equal(data.summary.expenses, '7.12');
      assert.equal(data.purchases[0]!.status, 'cancelled'); assert(data.expenses.find(e => e.id === paidExpense.id)!.deleted_at);
    });
    await check('frete do fornecedor não é somado duas vezes e frete extra gera alerta', async () => {
      const g = await group('Frete da viagem');
      await register({ ...purchaseInput(), group_id: g.id, freight_amount: 800 }, db);
      let data = await read(g.id, 'test', db); assert.equal(data.summary.total, '925.00'); assert.equal(data.summary.freight_included, '800.00'); assert(!data.summary.freight_warning);
      await expense({ environment: 'test', group_id: g.id, category: 'frete', amount: 10, created_by: actor, idempotency_key: key() }, db);
      data = await read(g.id, 'test', db); assert.equal(data.summary.total, '935.00'); assert(data.summary.freight_warning);
    });
    await check('FK composta e consultas isolam test de prod', async () => {
      await rejects(() => db.query(`INSERT INTO commerce.wholesale_purchase_group_purchases(environment,group_id,purchase_id,linked_by)
        VALUES ('prod',$1,$2,$3)`, [a.id, mainPurchase.purchase_id, actor]), /purchase_group_not_found|foreign key/);
      await rejects(() => db.query(`INSERT INTO commerce.wholesale_purchase_group_expenses(environment,group_id,expense_id,linked_by)
        VALUES ('prod',$1,$2,$3)`, [a.id, expenseA.id, actor]), /purchase_group_not_found|foreign key/);
      const fks = (await db.query(`SELECT pg_get_constraintdef(oid) definition FROM pg_constraint
        WHERE contype='f' AND conrelid IN ('commerce.wholesale_purchase_group_purchases'::regclass,
          'commerce.wholesale_purchase_group_expenses'::regclass)`)).rows;
      assert.equal(fks.length, 4); for (const fk of fks) assert.match(fk.definition, /FOREIGN KEY \(environment,/);
      await rejects(() => read(a.id, 'prod', db), /purchase_group_not_found/);
    });
    await check('fechada recusa vínculos; reabre; exclusão exige vazia', async () => {
      await change({ environment: 'test', actor, group_id: a.id, action: 'close', idempotency_key: key() }, db);
      await rejects(() => bind(a.id, 'purchase', avulsa.purchase_id), /purchase_group_closed/);
      await rejects(() => bind(a.id, 'expense', expenseA.id), /purchase_group_closed/);
      await rejects(() => bind(a.id, 'expense', expenseA.id, true), /purchase_group_closed/);
      await rejects(() => bind(a.id, 'purchase', avulsa.purchase_id, true), /purchase_group_closed/);
      await rejects(() => change({ environment: 'test', actor, group_id: a.id, action: 'delete', idempotency_key: key() }, db), /purchase_group_not_empty/);
      await change({ environment: 'test', actor, group_id: a.id, action: 'reopen', idempotency_key: key() }, db);
      await change({ environment: 'test', actor, group_id: a.id, action: 'rename', name: 'Viagem renomeada', idempotency_key: key() }, db);
      await change({ environment: 'test', actor, group_id: b.id, action: 'delete', idempotency_key: key() }, db);
      assert.equal((await read(a.id, 'test', db)).group.name, 'Viagem renomeada');
    });
    await check('mesma chave com outra viagem conflita no cadastro', async () => {
      await rejects(() => register({ ...originalInput!, group_id: spending.id }, db), /idempotency_conflict/);
      const input = { environment: 'test' as const, category: 'outros', amount: 1, group_id: a.id, idempotency_key: key(), created_by: actor };
      await expense(input, db); await rejects(() => expense({ ...input, group_id: spending.id }, db), /idempotency_conflict/);
    });
    await check('RLS e nenhum grant de tabela ou coluna ao parceiro', async () => {
      for (const table of ['wholesale_purchase_groups', 'wholesale_purchase_group_purchases', 'wholesale_purchase_group_expenses']) {
        const name = 'commerce.' + table;
        assert((await db.query('SELECT relrowsecurity enabled FROM pg_class WHERE oid=$1::regclass', [name])).rows[0].enabled);
        for (const role of ['anon', 'authenticated', 'partner_app', 'farejador_partner_app']) {
          if (!(await db.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount) continue;
          const row = (await db.query(`SELECT has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE') allowed,
            has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE') columns`, [role, name])).rows[0];
          assert.equal(row.allowed, false); assert.equal(row.columns, false);
        }
      }
    });
    assert.equal(completed, 15);
  } finally {
    await client.query('ROLLBACK');
    assert.deepEqual(await snapshot(), before, 'ROLLBACK externo preservou financeiro, estoque e origens');
    client.release(); await pool.end();
  }
  console.log('15/15 provas verdes. BEGIN/ROLLBACK: banco preservado.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
