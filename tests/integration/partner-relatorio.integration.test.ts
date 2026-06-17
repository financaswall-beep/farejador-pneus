/**
 * Teste de CONTRATO dos relatórios da aba Relatórios (0108+):
 *   - getPartnerRelatorioCaixa  → lente "Vendi × gastei"
 *   - getPartnerRelatorioPneus  → ranking de pneu mais vendido
 *
 * Por que existe: o Caixa mexe com DINHEIRO (contrato). Aqui a gente PROVA, com
 * dados semeados de data controlada, que:
 *   1. ENTROU só conta venda REALIZADA (retirada/balcão na hora; delivery só
 *      'delivered') e datada pelo realizado (delivered_at na entrega).
 *   2. SAIU = despesas + compras do período.
 *   3. 🔒 anti-duplo-cômputo: compra a prazo gera um payable, mas o SAIU NÃO o
 *      soma de novo (senão a compra entraria 2×).
 *   4. Período corta certo (fora da janela não entra) e cancelado nunca entra.
 *   5. Pneus: agrupa por medida/marca, soma unidades por created_at (não pelo
 *      realizado — é "o que está saindo"), ordena por quantidade, exclui cancelado.
 *
 * Roda em testcontainers (Postgres efêmero) — precisa Docker; `npm run test:integration`.
 * Semeia via as funções já testadas (registerPartnerSale/Expense/Purchase) + UPDATE
 * pontual de data/status, no estilo de partner-portal.integration.test.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startPostgres, stopPostgres, type IntegrationDb } from './helpers/postgres';
import { createPartnerFixture, type PartnerFixture } from './helpers/partner-fixtures';

let db: IntegrationDb;

beforeAll(async () => {
  db = await startPostgres();
  process.env.DATABASE_URL = db.connectionString;
  process.env.FAREJADOR_ENV = 'test';
  process.env.NODE_ENV = 'test';
  process.env.CHATWOOT_HMAC_SECRET = 'test-secret-not-used-here';
  process.env.ADMIN_AUTH_TOKEN = 'admin-not-used-here-1234567890';
}, 180_000);

afterAll(async () => {
  if (db) await stopPostgres(db);
});

async function importQueries() {
  return import('../../src/parceiro/queries.js');
}

// Janela = MARÇO/2026 (ISO de meia-noite local de São Paulo = 03:00Z).
const FROM = '2026-03-01T03:00:00.000Z';
const TO = '2026-04-01T03:00:00.000Z';

type Q = Awaited<ReturnType<typeof importQueries>>;

/** Insere um 2º item de estoque (Pirelli) na unidade, pra testar o agrupamento. */
async function insertStock(unitId: string, itemName: string, tireSize: string, brand: string): Promise<string> {
  const r = await db.pool.query<{ id: string }>(
    `INSERT INTO commerce.partner_stock_levels (
       environment, unit_id, item_name, tire_size, brand,
       quantity_on_hand, minimum_quantity, average_cost, sale_price,
       is_tracked, stock_status, updated_by
     ) VALUES ('test', $1, $2, $3, $4, 20, 2, 80, 150, true, 'in_stock', 'fixture')
     RETURNING id`,
    [unitId, itemName, tireSize, brand],
  );
  return r.rows[0]!.id;
}

async function setOrderDates(orderId: string, fields: { created_at?: string; delivered_at?: string; delivery_status?: string }): Promise<void> {
  await db.pool.query(
    `UPDATE commerce.partner_orders
        SET created_at      = COALESCE($2::timestamptz, created_at),
            delivered_at    = COALESCE($3::timestamptz, delivered_at),
            delivery_status = COALESCE($4::text, delivery_status)
      WHERE id = $1`,
    [orderId, fields.created_at ?? null, fields.delivered_at ?? null, fields.delivery_status ?? null],
  );
}

/**
 * Cenário semeado (Michelin = estoque da fixture; Pirelli = inserido):
 *   A pickup  M×2 @150 = 300  created 03-15        → caixa +300 ; pneus M+2
 *   B deliv.  M×1 @200 = 200  delivered 03-20 (criada 02-25) → caixa +200 (pelo delivered_at) ; pneus exclui (created fora)
 *   C deliv.  M×1 @999 = 999  pending, created 03-10 → caixa NÃO (pending) ; pneus M+1 (created na janela, não-cancelado)
 *   D pickup  P×1 @250 = 250  created 03-18        → caixa +250 ; pneus P+1
 *   E pickup  M×1 @500        created 04-05 (fora)  → exclui dos dois
 *   F pickup  M×1 @300        created 03-12, CANCELADA → exclui dos dois
 * Despesas: 50 (03-05, dentro) + 70 (04-02, fora)        → despesas 50
 * Compras:  80 (03-08, A PRAZO→gera payable) + 90 (04-10, fora) → compras 80
 * Esperado caixa: entrou 750, vendas_count 3, despesas 50, compras 80, saiu 130, saldo 620.
 * Esperado pneus: Michelin 3, Pirelli 1 (Michelin primeiro).
 */
async function seedScenario(q: Q, f: PartnerFixture): Promise<string> {
  const M = f.stockId;
  const P = await insertStock(f.unitId, 'Pneu Pirelli', '175/70R13', 'Pirelli');
  const mk = (mode: 'pickup' | 'delivery', stock: string, qty: number, price: number) =>
    q.registerPartnerSale(f.ctx, {
      customer_name: 'Cliente', customer_phone: null,
      items: [{ partner_stock_id: stock, quantity: qty, unit_price: price }],
      payment_method: 'pix', fulfillment_mode: mode,
      delivery_address: mode === 'delivery' ? 'Rua Teste, 100' : null,
      source_tag: 'porta', idempotency_key: `rel-${randomUUID()}`,
    });

  const a = await mk('pickup', M, 2, 150); await setOrderDates(a.order_id, { created_at: '2026-03-15T12:00:00Z' });
  const b = await mk('delivery', M, 1, 200); await setOrderDates(b.order_id, { created_at: '2026-02-25T12:00:00Z', delivered_at: '2026-03-20T12:00:00Z', delivery_status: 'delivered' });
  const c = await mk('delivery', M, 1, 999); await setOrderDates(c.order_id, { created_at: '2026-03-10T12:00:00Z' });
  const d = await mk('pickup', P, 1, 250); await setOrderDates(d.order_id, { created_at: '2026-03-18T12:00:00Z' });
  const e = await mk('pickup', M, 1, 500); await setOrderDates(e.order_id, { created_at: '2026-04-05T12:00:00Z' });
  const fO = await mk('pickup', M, 1, 300); await setOrderDates(fO.order_id, { created_at: '2026-03-12T12:00:00Z' });
  await q.cancelPartnerSale(f.ctx, fO.order_id);

  await q.registerPartnerExpense(f.ctx, { expense_date: '2026-03-05', category: 'outros', description: 'dentro', amount: 50, payment_method: 'pix', idempotency_key: `e1-${randomUUID()}` });
  await q.registerPartnerExpense(f.ctx, { expense_date: '2026-04-02', category: 'outros', description: 'fora', amount: 70, payment_method: 'pix', idempotency_key: `e2-${randomUUID()}` });

  await q.registerPartnerPurchase(f.ctx, { supplier_name: 'Fornecedor', purchased_at: '2026-03-08', items: [{ item_name: 'Pneu X', quantity: 2, unit_cost: 40 }], payment_method: 'pix', payment_status: 'payable', payable_due_date: '2026-04-08', idempotency_key: `p1-${randomUUID()}` });
  await q.registerPartnerPurchase(f.ctx, { supplier_name: 'Fornecedor', purchased_at: '2026-04-10', items: [{ item_name: 'Pneu Y', quantity: 1, unit_cost: 90 }], payment_method: 'pix', payment_status: 'paid_now', idempotency_key: `p2-${randomUUID()}` });

  return P;
}

describe('Relatório Caixa — "Vendi × gastei" (contrato de dinheiro)', () => {
  it('entrou conta só venda realizada; saiu = despesas + compras; anti-duplo-cômputo do payable', async () => {
    const q = await importQueries();
    const f = await createPartnerFixture(db.pool, { initialStockQty: 20, role: 'owner', slugSuffix: 'cx' + randomUUID().slice(0, 6) });
    await seedScenario(q, f);

    const caixa = await q.getPartnerRelatorioCaixa(f.ctx, { from: FROM, to: TO });

    expect(caixa.entrou).toBe(750);          // A(300) + B(200, pelo delivered_at) + D(250); C pending e E fora não entram
    expect(caixa.vendas_count).toBe(3);
    expect(caixa.despesas_total).toBe(50);   // só a de 03-05
    expect(caixa.compras_total).toBe(80);    // só a de 03-08
    expect(caixa.saiu).toBe(130);            // 50 + 80 — NÃO 210 (o payable de 80 não é somado de novo)
    expect(caixa.saldo).toBe(620);           // 750 - 130

    // O payable da compra a prazo EXISTE (prova de que o anti-duplo-cômputo é real, não ausência de dado).
    const pay = await db.pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM finance.partner_payables WHERE unit_id = $1 AND source_purchase_id IS NOT NULL`,
      [f.unitId],
    );
    expect(Number(pay.rows[0]!.c)).toBeGreaterThan(0);
  });

  it('janela vazia (sem nada no período) zera tudo sem quebrar', async () => {
    const q = await importQueries();
    const f = await createPartnerFixture(db.pool, { initialStockQty: 20, role: 'owner', slugSuffix: 'cx0' + randomUUID().slice(0, 6) });
    const caixa = await q.getPartnerRelatorioCaixa(f.ctx, { from: FROM, to: TO });
    expect(caixa).toEqual({ entrou: 0, saiu: 0, saldo: 0, vendas_total: 0, vendas_count: 0, despesas_total: 0, compras_total: 0 });
  });
});

describe('Relatório Pneu mais vendido — ranking por medida/marca', () => {
  it('agrupa e soma unidades por created_at, ordena por qtd, exclui cancelado e fora-da-janela', async () => {
    const q = await importQueries();
    const f = await createPartnerFixture(db.pool, { initialStockQty: 20, role: 'owner', slugSuffix: 'pn' + randomUUID().slice(0, 6) });
    await seedScenario(q, f);

    const rows = await q.getPartnerRelatorioPneus(f.ctx, { from: FROM, to: TO }) as Array<{ medida: string; marca: string; qtd: number; faturamento: string }>;

    // 2 grupos: Michelin 90/90-18 (A=2 + C=1; B fora por created_at) e Pirelli (D=1).
    expect(rows).toHaveLength(2);
    expect(rows[0]!.marca).toBe('Michelin');
    expect(rows[0]!.qtd).toBe(3);
    const pirelli = rows.find((r) => r.marca === 'Pirelli');
    expect(pirelli?.qtd).toBe(1);
    // Ordenação: maior quantidade primeiro.
    expect(rows[0]!.qtd).toBeGreaterThanOrEqual(rows[1]!.qtd);
  });
});
