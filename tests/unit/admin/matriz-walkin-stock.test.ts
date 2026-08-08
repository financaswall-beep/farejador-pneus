import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import {
  applyMatrizWalkinStockSale,
  prepareMatrizWalkinStock,
} from '../../../src/admin/painel/matriz-walkin-stock.js';

const items = [{ productId: '11111111-1111-4111-8111-111111111111', quantity: 2 }];

function preparationClient(options: {
  tireSize?: string | null;
  stockRows?: Array<{ measure: string; brand: string; tire_condition: 'meia_vida' | 'novo' | 'remold';
    quantity_on_hand: number; unit_cost: string | null }>;
}) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('commerce.tire_specs')) {
      return {
        rows: [{
          product_id: items[0]!.productId,
          product_type: 'tire',
          tire_size: options.tireSize ?? null,
          brand: 'Pirelli',
          tire_condition: 'meia_vida',
        }],
      };
    }
    if (sql.includes('commerce.wholesale_stock') && sql.includes('FOR UPDATE')) {
      return { rows: options.stockRows ?? [] };
    }
    throw new Error(`consulta inesperada: ${sql}`);
  });
  return { client: { query } as unknown as PoolClient, query };
}

describe('estoque atomico da venda walk-in da matriz', () => {
  it('trava a medida e prepara quantidade + custo congelado', async () => {
    const { client, query } = preparationClient({
      tireSize: '90/90-12',
      stockRows: [{
        measure: '90/90 12', brand: 'Pirelli', tire_condition: 'meia_vida',
        quantity_on_hand: 3, unit_cost: '47.50',
      }],
    });

    const plan = await prepareMatrizWalkinStock(client, 'test', items);

    expect(plan.lines).toEqual([{
      measure: '90/90 12',
      brand: 'Pirelli',
      tire_condition: 'meia_vida',
      quantity: 2,
    }]);
    expect(plan.costByProduct.get(items[0]!.productId)).toBe(47.5);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('FOR UPDATE'))).toBe(true);
  });

  it('rejeita produto sem medida', async () => {
    const { client } = preparationClient({});
    await expect(prepareMatrizWalkinStock(client, 'test', items))
      .rejects.toThrow('walkin_measure_not_found');
  });

  it('aceita serviço sem movimentar estoque e congela custo zero', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('commerce.products p')) return {
        rows: [{
          product_id: items[0]!.productId,
          product_type: 'service',
          tire_size: null,
          brand: null,
          tire_condition: null,
        }],
      };
      throw new Error(`consulta inesperada: ${sql}`);
    });
    const client = { query } as unknown as PoolClient;

    const plan = await prepareMatrizWalkinStock(client, 'test', items);

    expect(plan.lines).toEqual([]);
    expect(plan.costByProduct.get(items[0]!.productId)).toBe(0);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('wholesale_stock'))).toBe(false);
  });

  it('rejeita medida sem custo', async () => {
    const { client } = preparationClient({
      tireSize: '90/90-12',
      stockRows: [{
        measure: '90/90-12', brand: 'Pirelli', tire_condition: 'meia_vida',
        quantity_on_hand: 3, unit_cost: null,
      }],
    });
    await expect(prepareMatrizWalkinStock(client, 'test', items))
      .rejects.toThrow('walkin_cost_missing');
  });

  it('rejeita custo zero usado como default sem apuracao', async () => {
    const { client } = preparationClient({
      tireSize: '90/90-12',
      stockRows: [{
        measure: '90/90-12', brand: 'Pirelli', tire_condition: 'meia_vida',
        quantity_on_hand: 3, unit_cost: '0',
      }],
    });
    await expect(prepareMatrizWalkinStock(client, 'test', items))
      .rejects.toThrow('walkin_cost_missing');
  });

  it('rejeita estoque insuficiente sem usar clamp', async () => {
    const { client } = preparationClient({
      tireSize: '90/90-12',
      stockRows: [{
        measure: '90/90-12', brand: 'Pirelli', tire_condition: 'meia_vida',
        quantity_on_hand: 1, unit_cost: '47.50',
      }],
    });
    await expect(prepareMatrizWalkinStock(client, 'test', items))
      .rejects.toThrow('walkin_stock_insufficient');
  });

  it('baixa estritamente e cria trilha dentro da transacao', async () => {
    const queries: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes('UPDATE commerce.wholesale_stock')) return { rows: [{ quantity_on_hand: 1 }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }),
    } as unknown as PoolClient;

    await applyMatrizWalkinStockSale(client, 'test', '22222222-2222-4222-8222-222222222222', {
      lines: [{
        measure: '90/90-12', brand: 'Pirelli', tire_condition: 'meia_vida', quantity: 2,
      }],
      costByProduct: new Map([[items[0]!.productId, 47.5]]),
    });

    const decrement = queries.find((entry) => entry.sql.includes('UPDATE commerce.wholesale_stock'))!;
    expect(decrement.sql).toContain('quantity_on_hand - $5');
    expect(decrement.sql).toContain('quantity_on_hand-quantity_reserved >= $5');
    expect(decrement.sql).not.toContain('GREATEST');
    expect(queries.some((entry) => entry.sql.includes("'matriz_galpao_decrement'"))).toBe(true);
  });
});
