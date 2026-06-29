import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { applyMatrizGalpaoDecrement } from '../../../src/atendente-v2/wholesale-stock-read.js';

// Mock do client: responde tire_specs / SELECT measure / captura os UPDATE.
function mockClient(
  specs: { product_id: string; tire_size: string | null }[],
  stock: { measure: string }[],
) {
  const updates: Array<[string, string, number]> = [];
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes('commerce.tire_specs')) return { rows: specs };
    if (sql.includes('UPDATE commerce.wholesale_stock')) {
      updates.push(params as [string, string, number]);
      return { rowCount: 1 };
    }
    if (sql.includes('SELECT measure')) return { rows: stock };
    return { rows: [] };
  });
  return { client: { query } as unknown as PoolClient, query, updates };
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

  it('produto sem medida no galpão (ex.: carro): NÃO baixa nada (não trava a venda)', async () => {
    const { client, updates } = mockClient(
      [{ product_id: 'p1', tire_size: '175/70-13' }],
      [{ measure: '90/90-12' }],
    );
    await applyMatrizGalpaoDecrement(client, 'prod', [{ productId: 'p1', quantity: 1 }], true);
    expect(updates).toEqual([]);
  });
});
