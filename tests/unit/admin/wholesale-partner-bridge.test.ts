import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import {
  cancelLinkedPartnerPurchase,
  createLinkedPartnerPurchase,
  resolveWholesalePartnerUnit,
  settleLinkedPartnerPayable,
} from '../../../src/admin/painel/wholesale-partner-bridge.js';

function client(query: ReturnType<typeof vi.fn>): PoolClient {
  return { query } as unknown as PoolClient;
}

describe('ponte de estoque Matriz → parceiro', () => {
  it('não cria vínculo para comprador somente atacado', async () => {
    const query = vi.fn();
    await expect(resolveWholesalePartnerUnit(client(query), 'test', null, null))
      .resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('exige escolha quando o parceiro possui mais de uma unidade', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [
      { partner_unit_id: 'pu-1', unit_id: 'u-1', display_name: 'A' },
      { partner_unit_id: 'pu-2', unit_id: 'u-2', display_name: 'B' },
    ] });
    await expect(resolveWholesalePartnerUnit(client(query), 'test', 'partner-1', null))
      .rejects.toThrow('partner_unit_required');
  });

  it('espelha venda fiada como compra pendente e conta a pagar', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT o.id AS order_id')) return { rows: [{
        order_id: 'order-1', partner_unit_id: 'pu-1', unit_id: 'unit-1',
        sold_at: '2026-08-17T15:00:00.000Z', total_amount: '250.00',
        payment_status: 'pending', partner_payment_terms: 'credit',
        due_date: '2026-08-25', parent_order_id: null,
      }] };
      if (sql.includes('INSERT INTO commerce.partner_purchases')) {
        return { rows: [{ id: 'purchase-1' }] };
      }
      if (sql.includes('INSERT INTO commerce.partner_purchase_items')) {
        return { rows: [], rowCount: 2 };
      }
      return { rows: [], rowCount: 1 };
    });
    const result = await createLinkedPartnerPurchase(
      client(query), 'test', 'order-1', 'Wallace',
    );
    expect(result).toEqual({ purchase_id: 'purchase-1', unit_id: 'unit-1' });
    const header = query.mock.calls.find(([sql]) => String(sql)
      .includes('INSERT INTO commerce.partner_purchases'))!;
    expect(header[1]).toEqual([
      'test', 'order-1', 'matrix:Wallace', 'matrix-wholesale:order-1',
    ]);
    expect(String(header[0])).toContain("'payable'");
    expect(query.mock.calls.some(([sql]) => String(sql)
      .includes('INSERT INTO finance.partner_payables'))).toBe(true);
  });

  it('mantém a compra à vista aberta até o acerto na chegada', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT o.id AS order_id')) return { rows: [{
        order_id: 'order-cash', partner_unit_id: 'pu-1', unit_id: 'unit-1',
        sold_at: '2026-08-18T02:00:00.000Z', total_amount: '135.02',
        payment_status: 'pending', partner_payment_terms: 'cash_on_arrival',
        due_date: null, parent_order_id: null,
      }] };
      if (sql.includes('INSERT INTO commerce.partner_purchases')) {
        return { rows: [{ id: 'purchase-cash' }] };
      }
      if (sql.includes('INSERT INTO commerce.partner_purchase_items')) {
        return { rows: [], rowCount: 2 };
      }
      return { rows: [], rowCount: 1 };
    });

    await createLinkedPartnerPurchase(client(query), 'test', 'order-cash', 'Wallace');

    const purchaseSql = String(query.mock.calls.find(([sql]) => String(sql)
      .includes('INSERT INTO commerce.partner_purchases'))![0]);
    expect(purchaseSql).toContain("THEN 'À vista no acerto'");
    expect(purchaseSql).toContain("'payable'");
    const payable = query.mock.calls.find(([sql]) => String(sql)
      .includes('INSERT INTO finance.partner_payables'))!;
    expect(payable[1]).toContain('2026-08-18T02:00:00.000Z');
    expect(String(payable[0])).toContain("'open'");
  });

  it('não deixa cancelar depois que a unidade confirmou o recebimento', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      purchase_id: 'purchase-1', receipt_status: 'received', payment_status: 'pending',
    }] });
    await expect(cancelLinkedPartnerPurchase(
      client(query), 'test', 'order-1', 'Wallace', 'cancelamento',
    )).rejects.toThrow('partner_receipt_already_confirmed');
  });

  it('não exige conta parceira para venda sem vínculo', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await expect(settleLinkedPartnerPayable(
      client(query), 'test', 'order-1', '2026-08-17T15:00:00.000Z', 'Wallace',
    )).resolves.toBeNull();
  });

  it('quita junto a conta e a compra espelhada depois do acerto fiado', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT p.id AS purchase_id')) {
        return { rows: [{ purchase_id: 'purchase-1', unit_id: 'unit-1' }] };
      }
      if (sql.includes('SELECT id AS payable_id')) {
        return { rows: [{ payable_id: 'payable-1' }] };
      }
      if (sql.includes('UPDATE finance.partner_payables')) {
        return { rows: [{ id: 'payable-1' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(settleLinkedPartnerPayable(
      client(query), 'test', 'order-1', '2026-08-18T15:00:00.000Z',
      'Wallace', 'pix',
    )).resolves.toBe('payable-1');

    const purchaseUpdate = query.mock.calls.find(([sql]) => String(sql)
      .includes('UPDATE commerce.partner_purchases'))!;
    expect(String(purchaseUpdate[0])).toContain("payment_status='paid_now'");
    expect(purchaseUpdate[1]).toEqual(['test', 'purchase-1', 'pix']);
  });
});
