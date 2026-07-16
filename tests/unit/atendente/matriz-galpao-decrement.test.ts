import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { applyMatrizGalpaoDecrement } from '../../../src/atendente-v2/wholesale-stock-read.js';

// Mock do client: responde tire_specs / SELECT measure / captura os UPDATE (que agora
// devolvem old_qty/new_qty do RETURNING) / captura o INSERT da trilha (audit.events).
function mockClient(
  specs: { product_id: string; tire_size: string | null }[],
  stock: { measure: string }[],
  onHand = 10, // qty antes da baixa (a devolvida no old_qty; new = clamp em 0)
) {
  const updates: Array<[string, string, number]> = [];
  const audits: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes('commerce.tire_specs')) return { rows: specs };
    if (sql.includes('UPDATE commerce.wholesale_stock')) {
      updates.push(params as [string, string, number]);
      const req = Number((params as [string, string, number])[2]);
      return { rows: [{ old_qty: String(onHand), new_qty: String(Math.max(0, onHand - req)) }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO audit.events')) {
      audits.push({ sql, params });
      return { rows: [] };
    }
    if (sql.includes('SELECT measure')) {
      return { rows: stock.map((row) => ({ ...row, quantity_on_hand: onHand, unit_cost: 20 })) };
    }
    return { rows: [] };
  });
  return { client: { query } as unknown as PoolClient, query, updates, audits };
}

describe('applyMatrizGalpaoDecrement — baixa do galpão na venda da matriz (varejo)', () => {
  it('flag OFF: não toca em nada (a venda não baixa o galpão)', async () => {
    const { client, query } = mockClient([], []);
    await applyMatrizGalpaoDecrement(client, 'prod', [{ productId: 'p1', quantity: 1 }], false);
    expect(query).not.toHaveBeenCalled();
  });

  it('flag ON: abate a medida do produto vendido, com clamp, só a linha que casa', async () => {
    const { client, updates } = mockClient(
      [{ product_id: 'p1', tire_size: '90/90-12' }],
      [{ measure: '90/90-12' }, { measure: '100/90-18' }],
    );
    await applyMatrizGalpaoDecrement(client, 'prod', [{ productId: 'p1', quantity: 2 }], true);
    expect(updates).toEqual([['prod', '90/90-12', 2]]); // só 90/90-12, qtd 2; o GREATEST está no SQL
  });

  it('casa por NÚMEROS mesmo se o formato do galpão diferir do catálogo', async () => {
    const { client, updates } = mockClient(
      [{ product_id: 'p1', tire_size: '90/90-12' }],
      [{ measure: '90/90 12' }], // formato torto, mesma chave 90-90-12
    );
    await applyMatrizGalpaoDecrement(client, 'prod', [{ productId: 'p1', quantity: 1 }], true);
    expect(updates).toEqual([['prod', '90/90 12', 1]]);
  });

  it('agrega 2 itens da MESMA medida numa baixa só (2 + 1 = 3)', async () => {
    const { client, updates } = mockClient(
      [
        { product_id: 'p1', tire_size: '90/90-12' },
        { product_id: 'p2', tire_size: '90/90-12' },
      ],
      [{ measure: '90/90-12' }],
    );
    await applyMatrizGalpaoDecrement(
      client,
      'prod',
      [{ productId: 'p1', quantity: 2 }, { productId: 'p2', quantity: 1 }],
      true,
    );
    expect(updates).toEqual([['prod', '90/90-12', 3]]);
  });

  it('produto sem medida no galpao falha fechado', async () => {
    const { client, updates } = mockClient(
      [{ product_id: 'p1', tire_size: '175/70-13' }],
      [{ measure: '90/90-12' }],
    );
    await expect(applyMatrizGalpaoDecrement(
      client, 'prod', [{ productId: 'p1', quantity: 1 }], true,
    )).rejects.toThrow('walkin_measure_not_found');
    expect(updates).toEqual([]);
  });

  it('com orderId: grava a trilha da baixa (audit.events) com o delta REAL', async () => {
    const { client, audits } = mockClient(
      [{ product_id: 'p1', tire_size: '90/90-12' }],
      [{ measure: '90/90-12' }],
      10, // tinha 10; vende 2 → delta real 2
    );
    await applyMatrizGalpaoDecrement(client, 'prod', [{ productId: 'p1', quantity: 2 }], true, 'ord-1');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.sql).toContain('matriz_galpao_decrement');
    const payload = JSON.parse(audits[0]!.params[2] as string);
    expect(payload.movements).toEqual([{ measure: '90/90-12', qty: 2 }]);
  });

  it('recusa venda acima do saldo em vez de aplicar clamp', async () => {
    const { client, audits } = mockClient(
      [{ product_id: 'p1', tire_size: '90/90-12' }],
      [{ measure: '90/90-12' }],
      10, // tinha 10; vende 15 → clamp em 0, delta real 10
    );
    await expect(applyMatrizGalpaoDecrement(
      client, 'prod', [{ productId: 'p1', quantity: 15 }], true, 'ord-2',
    )).rejects.toThrow('walkin_stock_insufficient');
    expect(audits).toHaveLength(0);
  });

  it('sem orderId: baixa mas NÃO grava trilha (comportamento antigo preservado)', async () => {
    const { client, audits } = mockClient(
      [{ product_id: 'p1', tire_size: '90/90-12' }],
      [{ measure: '90/90-12' }],
    );
    await applyMatrizGalpaoDecrement(client, 'prod', [{ productId: 'p1', quantity: 2 }], true);
    expect(audits).toHaveLength(0);
  });
});
