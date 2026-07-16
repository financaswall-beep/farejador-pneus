import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { applyWholesaleStockDecrement } from '../../../src/admin/painel/wholesale-stock.js';

function mockClient(available = 10) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('UPDATE commerce.wholesale_stock')) {
      return { rows: [{ quantity_on_hand: available }] };
    }
    if (sql.includes('SELECT quantity_on_hand FROM commerce.wholesale_stock')) {
      return { rows: [{ quantity_on_hand: available }] };
    }
    return { rows: [] };
  });
  return { client: { query } as unknown as PoolClient, query };
}

describe('applyWholesaleStockDecrement — baixa estrita do estoque do galpão', () => {
  it('flag OFF: não toca no estoque', async () => {
    const { client, query } = mockClient();
    await applyWholesaleStockDecrement(client, 'test', [{ measure: '90/90-18', quantity: 3 }], false);
    expect(query).not.toHaveBeenCalled();
  });

  it('flag ON: rotula o movimento e só decrementa quando há saldo', async () => {
    const { client, query } = mockClient();
    await applyWholesaleStockDecrement(client, 'prod', [{ measure: '90/90-18', quantity: 3 }], true, 'order-x');
    expect(query).toHaveBeenCalledTimes(2);
    const [rotuloSql, rotuloParams] = query.mock.calls[0];
    expect(rotuloSql).toContain("set_config('app.galpao_source', 'venda_atacado', true)");
    expect(rotuloParams).toEqual(['order-x']);
    const [sql, params] = query.mock.calls[1];
    expect(sql).toContain('quantity_on_hand = quantity_on_hand - $3');
    expect(sql).toContain('quantity_on_hand >= $3');
    expect(sql).toContain('RETURNING quantity_on_hand');
    expect(sql).not.toContain('GREATEST');
    expect(params).toEqual(['prod', '90/90-18', 3]);
  });

  it('recusa a baixa sem saldo em vez de zerar artificialmente', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('UPDATE commerce.wholesale_stock')) return { rows: [] };
      if (sql.includes('SELECT quantity_on_hand FROM commerce.wholesale_stock')) {
        return { rows: [{ quantity_on_hand: 2 }] };
      }
      return { rows: [] };
    });
    const client = { query } as unknown as PoolClient;

    await expect(applyWholesaleStockDecrement(
      client, 'test', [{ measure: '90/90-18', quantity: 3 }], true,
    )).rejects.toThrow('oversell:[{"measure":"90/90-18","available":2,"requested":3}]');

    const updateSql = query.mock.calls.find(([sql]) => String(sql).includes('UPDATE commerce.wholesale_stock'))?.[0];
    expect(updateSql).not.toContain('GREATEST');
  });

  it('agrega itens da mesma medida numa baixa só', async () => {
    const { client, query } = mockClient();
    await applyWholesaleStockDecrement(
      client,
      'test',
      [{ measure: '90/90-18', quantity: 2 }, { measure: '90/90-18', quantity: 1 }],
      true,
    );
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][1]).toEqual(['test', '90/90-18', 3]);
  });

  it('ordena medidas diferentes e faz uma baixa por medida', async () => {
    const { client, query } = mockClient();
    await applyWholesaleStockDecrement(
      client,
      'test',
      [{ measure: '100/90-18', quantity: 1 }, { measure: '90/90-18', quantity: 2 }],
      true,
    );
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[1][1]).toEqual(['test', '100/90-18', 1]);
    expect(query.mock.calls[2][1]).toEqual(['test', '90/90-18', 2]);
  });

  it('ignora medida vazia sem gerar baixa fantasma nem rótulo', async () => {
    const { client, query } = mockClient();
    await applyWholesaleStockDecrement(client, 'test', [{ measure: '   ', quantity: 5 }], true);
    expect(query).not.toHaveBeenCalled();
  });

  it('normaliza espaços na medida antes de bater a chave', async () => {
    const { client, query } = mockClient();
    await applyWholesaleStockDecrement(client, 'test', [{ measure: '  90/90-18 ', quantity: 1 }], true);
    expect(query.mock.calls[1][1]).toEqual(['test', '90/90-18', 1]);
  });
});
