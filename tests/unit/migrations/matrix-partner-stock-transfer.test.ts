import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve('db/migrations/0183_matrix_partner_stock_transfer.sql'), 'utf8',
);

describe('migration 0183 — transferência Matriz para parceiro', () => {
  it('liga venda, unidade, compra e linhas exatas sem duplicidade', () => {
    expect(migration).toContain('parent_order_id');
    expect(migration).toContain('partner_unit_id');
    expect(migration).toContain('source_wholesale_order_id');
    expect(migration).toContain('source_wholesale_order_item_id');
    expect(migration).toContain('partner_purchases_source_wholesale_order_uniq');
    expect(migration).toContain('partner_purchase_items_source_wholesale_item_uniq');
  });

  it('impede unidade errada, recebimento maior e edição financeira pelo parceiro', () => {
    expect(migration).toContain('wholesale_partner_unit_buyer_mismatch');
    expect(migration).toContain('matrix_linked_purchase_item_values_mismatch');
    expect(migration).toContain('NEW.received_quantity>v_source.quantity');
    expect(migration).toContain('matrix_linked_payable_managed_by_matrix');
  });

  it('preserva acréscimos como filhos de um pedido raiz confirmado', () => {
    expect(migration).toContain('wholesale_parent_order_not_open_root');
    expect(migration).toContain('wholesale_addition_buyer_mismatch');
    expect(migration).toContain('wholesale_addition_partner_unit_mismatch');
  });
});
