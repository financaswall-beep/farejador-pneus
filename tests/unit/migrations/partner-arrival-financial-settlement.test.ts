import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  resolve('db/migrations/0187_partner_arrival_financial_settlement.sql'), 'utf8',
);

describe('migration 0187 — venda financeira somente no acerto da chegada', () => {
  it('separa forma de pagamento do estado ainda pendente', () => {
    expect(sql).toContain('partner_payment_terms');
    expect(sql).toContain("'cash_on_arrival','credit'");
    expect(sql).toContain("status='pending',payment_status='pending',paid_at=NULL");
    expect(sql).toContain('wholesale_orders_partner_transfer_lifecycle_check');
    expect(sql).toContain("partner_transfer_status='in_transit'");
    expect(sql).toContain("status='pending' AND payment_status='pending' AND paid_at IS NULL");
    expect(sql).toContain('guard_matrix_linked_partner_purchase');
    expect(sql).toContain("v_source.partner_transfer_status='in_transit'");
  });

  it('reclassifica o livro sem apagar o histórico financeiro', () => {
    expect(sql).toContain('finance.reverse_matriz_ledger_transaction');
    expect(sql).toContain('commerce.wholesale_order.partner_defer_revenue');
    expect(sql).toContain('commerce.wholesale_order.partner_defer_cogs');
    expect(sql).toContain('commerce.wholesale_order.partner_dispatch');
    expect(sql).toContain("'inventory_in_transit'");
    expect(sql).not.toMatch(/DELETE\s+FROM\s+finance\.matriz_ledger/i);
  });

  it('deixa compra e conta do parceiro aguardando o acerto', () => {
    expect(sql).toContain("SET payment_status='payable'");
    expect(sql).toContain('INSERT INTO finance.partner_payables');
    expect(sql).toContain("sale.partner_transfer_status='in_transit'");
  });
});
