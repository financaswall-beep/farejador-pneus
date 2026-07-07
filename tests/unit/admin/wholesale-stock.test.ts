import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { applyWholesaleStockDecrement } from '../../../src/admin/painel/wholesale-stock.js';

// Client de transação mockado: captura as chamadas a query() sem tocar em banco.
function mockClient() {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  return { client: { query } as unknown as PoolClient, query };
}

describe('applyWholesaleStockDecrement — baixa do estoque do galpão (atacado Fase 2b)', () => {
  it('flag OFF: não toca no estoque (a venda registra sem baixar)', async () => {
    const { client, query } = mockClient();
    await applyWholesaleStockDecrement(client, 'test', [{ measure: '90/90-18', quantity: 3 }], false);
    expect(query).not.toHaveBeenCalled();
  });

  it('flag ON: rotula o filme (0128) e decrementa com clamp em 0 (GREATEST)', async () => {
    const { client, query } = mockClient();
    await applyWholesaleStockDecrement(client, 'prod', [{ measure: '90/90-18', quantity: 3 }], true, 'order-x');
    expect(query).toHaveBeenCalledTimes(2);
    // 1ª query = o RÓTULO do movimento (set_config local — o trigger da 0128 lê)
    const [rotuloSql, rotuloParams] = query.mock.calls[0];
    expect(rotuloSql).toContain("set_config('app.galpao_source', 'venda_atacado', true)");
    expect(rotuloParams).toEqual(['order-x']);
    // 2ª query = a baixa em si
    const [sql, params] = query.mock.calls[1];
    expect(sql).toContain('GREATEST(0, quantity_on_hand'); // clamp: nunca fica negativo
    expect(sql).toContain('commerce.wholesale_stock');
    expect(params).toEqual(['prod', '90/90-18', 3]);
  });

  it('agrega itens da MESMA medida numa baixa só (2 + 1 = 3)', async () => {
    const { client, query } = mockClient();
    await applyWholesaleStockDecrement(
      client,
      'test',
      [{ measure: '90/90-18', quantity: 2 }, { measure: '90/90-18', quantity: 1 }],
      true,
    );
    expect(query).toHaveBeenCalledTimes(2); // rótulo + 1 baixa
    expect(query.mock.calls[1][1]).toEqual(['test', '90/90-18', 3]);
  });

  it('medidas diferentes: uma baixa por medida', async () => {
    const { client, query } = mockClient();
    await applyWholesaleStockDecrement(
      client,
      'test',
      [{ measure: '90/90-18', quantity: 2 }, { measure: '100/90-18', quantity: 1 }],
      true,
    );
    expect(query).toHaveBeenCalledTimes(3); // rótulo + 2 baixas
  });

  it('ignora medida vazia/em branco (não gera baixa fantasma nem rótulo)', async () => {
    const { client, query } = mockClient();
    await applyWholesaleStockDecrement(client, 'test', [{ measure: '   ', quantity: 5 }], true);
    expect(query).not.toHaveBeenCalled();
  });

  it('normaliza espaços na medida (trim antes de bater a chave)', async () => {
    const { client, query } = mockClient();
    await applyWholesaleStockDecrement(client, 'test', [{ measure: '  90/90-18 ', quantity: 1 }], true);
    expect(query.mock.calls[1][1]).toEqual(['test', '90/90-18', 1]);
  });
});
