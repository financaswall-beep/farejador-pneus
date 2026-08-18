import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve('db/migrations/0182_stock_end_to_end_integrity.sql'), 'utf8',
);

describe('migration 0182 — integridade ponta a ponta do estoque', () => {
  it('fecha a propriedade do estoque recebido no banco', () => {
    expect(migration).toContain('partner_purchase_item_received_stock_unit_guard');
    expect(migration).toContain('partner_purchase_received_stock_unit_mismatch');
  });

  it('não permite esconder estoque físico positivo', () => {
    expect(migration).toContain('partner_stock_inactivation_guard');
    expect(migration).toContain('stock_positive_cannot_delete');
    expect(migration).toContain('stock_reserved_cannot_delete');
  });

  it('impede que compras futuras contaminem estoque e financeiro', () => {
    expect(migration).toContain('partner_purchase_dates_guard');
    expect(migration).toContain('partner_purchased_at_future');
    expect(migration).toContain('partner_payable_due_before_purchase');
  });

  it('fecha total da compra e filme histórico sem inventar saldo', () => {
    expect(migration).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(migration).toContain('partner_purchase_total_mismatch');
    expect(migration).toContain("first.op='update'");
    expect(migration).toContain('first.qty_before=stock.quantity_on_hand-movement.delta_sum');
    expect(migration).toContain("'opening_balance_backfill'");
  });
});
