import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import {
  tireSizeKey,
  getMatrizWholesaleStockQty,
  getMatrizWholesaleStockMap,
} from '../../../src/atendente-v2/wholesale-stock-read.js';

describe('tireSizeKey — chave canônica da medida (a ponte casa formatos diferentes)', () => {
  it('mesmo pneu, separadores/letras diferentes → mesma chave', () => {
    expect(tireSizeKey('90/90-18')).toBe('90-90-18');
    expect(tireSizeKey('90/90R18')).toBe('90-90-18');
    expect(tireSizeKey(' 90/90 - 18 ')).toBe('90-90-18');
    expect(tireSizeKey('150/60ZR17')).toBe('150-60-17');
  });

  it('medida em polegada (mobilete) também casa', () => {
    expect(tireSizeKey('3.00-10')).toBe('3-00-10');
  });

  it('ignora índice de carga colado (pega só largura/perfil/aro)', () => {
    expect(tireSizeKey('90/90-18 62P')).toBe('90-90-18');
  });

  it('sem números → "" (não casa nada, seguro)', () => {
    expect(tireSizeKey('')).toBe('');
    expect(tireSizeKey(null)).toBe('');
    expect(tireSizeKey(undefined)).toBe('');
    expect(tireSizeKey('sem medida')).toBe('');
  });
});

describe('getMatrizWholesaleStockQty — ponte produto→medida→galpão', () => {
  function mockClient(tireSize: string | null, stockRows: Array<{ measure: string; quantity_on_hand: number }>) {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ tire_size: tireSize }] })
      .mockResolvedValueOnce({ rows: stockRows });
    return { client: { query } as unknown as PoolClient, query };
  }

  it('soma as linhas do galpão que batem a medida — inclusive formato diferente', async () => {
    const { client } = mockClient('90/90-18', [
      { measure: '90/90-18', quantity_on_hand: 10 },
      { measure: '90/90R18', quantity_on_hand: 5 }, // mesmo pneu, outro formato → conta
      { measure: '100/90-18', quantity_on_hand: 7 }, // outra medida → NÃO conta
    ]);
    expect(await getMatrizWholesaleStockQty(client, 'prod', 'pid-1')).toBe(15);
  });

  it('produto sem medida → 0 e nem consulta o galpão', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ tire_size: null }] });
    const client = { query } as unknown as PoolClient;
    expect(await getMatrizWholesaleStockQty(client, 'prod', 'pid-x')).toBe(0);
    expect(query).toHaveBeenCalledTimes(1); // parou na medida, não puxou wholesale_stock
  });

  it('galpão sem a medida → 0', async () => {
    const { client } = mockClient('90/90-18', []);
    expect(await getMatrizWholesaleStockQty(client, 'test', 'pid-2')).toBe(0);
  });
});

describe('getMatrizWholesaleStockMap — lote pra a busca (vários produtos)', () => {
  it('mapeia cada produto pra a soma do galpão na medida dele', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          { product_id: 'p1', tire_size: '90/90-18' },
          { product_id: 'p2', tire_size: '100/90-18' },
          { product_id: 'p3', tire_size: '120/80-17' },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { measure: '90/90-18', quantity_on_hand: 10 },
          { measure: '90/90R18', quantity_on_hand: 5 }, // mesmo pneu de p1 → soma
          { measure: '100/90-18', quantity_on_hand: 3 },
        ],
      });
    const client = { query } as unknown as PoolClient;
    const map = await getMatrizWholesaleStockMap(client, 'prod', ['p1', 'p2', 'p3']);
    expect(map.get('p1')).toBe(15); // 10 + 5 (formatos diferentes do mesmo pneu)
    expect(map.get('p2')).toBe(3);
    expect(map.get('p3')).toBe(0); // galpão não tem essa medida
  });

  it('lista vazia → map vazio, sem tocar no banco', async () => {
    const query = vi.fn();
    const client = { query } as unknown as PoolClient;
    const map = await getMatrizWholesaleStockMap(client, 'test', []);
    expect(map.size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});
