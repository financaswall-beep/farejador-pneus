import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import {
  tireSizeKey,
  getMatrizWholesaleStockQty,
  getMatrizWholesaleStockMap,
  checkMatrizGalpaoShortfall,
  getMatrizGalpaoCostByProduct,
  applyMatrizRetailCostSnapshot,
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
      .mockResolvedValueOnce({ rows: stockRows.map((row) => ({ ...row, unit_cost: 20 })) });
    return { client: { query } as unknown as PoolClient, query };
  }

  it('bloqueia duas linhas oficiais para a mesma medida canonica', async () => {
    const { client } = mockClient('90/90-18', [
      { measure: '90/90-18', quantity_on_hand: 10 },
      { measure: '90/90R18', quantity_on_hand: 5 }, // mesmo pneu, outro formato → conta
      { measure: '100/90-18', quantity_on_hand: 7 }, // outra medida → NÃO conta
    ]);
    expect(await getMatrizWholesaleStockQty(client, 'prod', 'pid-1')).toBe(0);
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
          { measure: '90/90-18', quantity_on_hand: 10, unit_cost: 20 },
          { measure: '90/90R18', quantity_on_hand: 5, unit_cost: 20 },
          { measure: '100/90-18', quantity_on_hand: 3, unit_cost: 21 },
        ],
      });
    const client = { query } as unknown as PoolClient;
    const map = await getMatrizWholesaleStockMap(client, 'prod', ['p1', 'p2', 'p3']);
    expect(map.get('p1')).toBe(0); // duplicidade canonica falha fechada
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

describe('checkMatrizGalpaoShortfall — trava de oversell da matriz no varejo (Camada 1b)', () => {
  // 1ª query = tire_specs (produto→medida); 2ª = wholesale_stock (FOR UPDATE)
  function mockClient(
    specRows: Array<{ product_id: string; tire_size: string | null }>,
    stockRows: Array<{ measure: string; quantity_on_hand: number }>,
  ) {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: specRows })
      .mockResolvedValueOnce({ rows: stockRows.map((row) => ({ ...row, unit_cost: 20 })) });
    return { client: { query } as unknown as PoolClient, query };
  }

  it('estoque suficiente → sem falta (pode vender)', async () => {
    const { client } = mockClient(
      [{ product_id: 'p1', tire_size: '90/90-18' }],
      [{ measure: '90/90-18', quantity_on_hand: 10 }],
    );
    expect(await checkMatrizGalpaoShortfall(client, 'prod', [{ productId: 'p1', quantity: 2 }])).toEqual([]);
  });

  it('pediu mais do que tem → falta com disponível e pedido', async () => {
    const { client } = mockClient(
      [{ product_id: 'p1', tire_size: '90/90-18' }],
      [{ measure: '90/90-18', quantity_on_hand: 3 }],
    );
    expect(await checkMatrizGalpaoShortfall(client, 'prod', [{ productId: 'p1', quantity: 5 }])).toEqual([
      { measure: '90/90-18', available: 3, requested: 5 },
    ]);
  });

  it('formatos diferentes da mesma medida bloqueiam por ambiguidade', async () => {
    const { client } = mockClient(
      [{ product_id: 'p1', tire_size: '90/90-18' }],
      [
        { measure: '90/90-18', quantity_on_hand: 10 },
        { measure: '90/90R18', quantity_on_hand: 5 }, // mesmo pneu → soma 15
      ],
    );
    expect(await checkMatrizGalpaoShortfall(client, 'prod', [{ productId: 'p1', quantity: 12 }])).toEqual([
      { measure: '90/90-18', available: 0, requested: 12 },
    ]);
  });

  it('galpão vazio → falta tudo (não vende do vazio)', async () => {
    const { client } = mockClient([{ product_id: 'p1', tire_size: '90/90-18' }], []);
    expect(await checkMatrizGalpaoShortfall(client, 'test', [{ productId: 'p1', quantity: 1 }])).toEqual([
      { measure: '90/90-18', available: 0, requested: 1 },
    ]);
  });

  it('produto sem medida casável → falta (disponível 0) e nem consulta o galpão', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ product_id: 'p1', tire_size: null }] });
    const client = { query } as unknown as PoolClient;
    expect(await checkMatrizGalpaoShortfall(client, 'prod', [{ productId: 'p1', quantity: 2 }])).toEqual([
      { measure: 'medida não identificada', available: 0, requested: 2 },
    ]);
    expect(query).toHaveBeenCalledTimes(1); // parou na medida, não travou o galpão à toa
  });

  it('dois produtos: um ok, um falta → só o que falta aparece', async () => {
    const { client } = mockClient(
      [
        { product_id: 'p1', tire_size: '90/90-18' },
        { product_id: 'p2', tire_size: '100/90-18' },
      ],
      [
        { measure: '90/90-18', quantity_on_hand: 10 },
        { measure: '100/90-18', quantity_on_hand: 1 },
      ],
    );
    expect(
      await checkMatrizGalpaoShortfall(client, 'prod', [
        { productId: 'p1', quantity: 2 },
        { productId: 'p2', quantity: 4 },
      ]),
    ).toEqual([{ measure: '100/90-18', available: 1, requested: 4 }]);
  });

  it('mesma medida em 2 produtos soma o PEDIDO por chave → falta no agregado', async () => {
    const { client } = mockClient(
      [
        { product_id: 'p1', tire_size: '90/90-18' },
        { product_id: 'p2', tire_size: '90/90R18' }, // mesma chave
      ],
      [{ measure: '90/90-18', quantity_on_hand: 5 }],
    );
    expect(
      await checkMatrizGalpaoShortfall(client, 'prod', [
        { productId: 'p1', quantity: 3 },
        { productId: 'p2', quantity: 3 }, // total 6 > 5
      ]),
    ).toEqual([{ measure: '90/90-18', available: 5, requested: 6 }]);
  });

  it('lista vazia (ou qty 0) → sem falta e sem tocar no banco', async () => {
    const query = vi.fn();
    const client = { query } as unknown as PoolClient;
    expect(await checkMatrizGalpaoShortfall(client, 'test', [])).toEqual([]);
    expect(await checkMatrizGalpaoShortfall(client, 'test', [{ productId: 'p1', quantity: 0 }])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('getMatrizGalpaoCostByProduct — custo médio do galpão por produto (0117)', () => {
  function mockClient(
    specs: Array<{ product_id: string; tire_size: string | null }>,
    stockRows: Array<{ measure: string; quantity_on_hand: number; unit_cost: string | null }>,
  ) {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: specs })
      .mockResolvedValueOnce({ rows: stockRows });
    return { client: { query } as unknown as PoolClient, query };
  }

  it('devolve o unit_cost da medida que casa — inclusive formato diferente', async () => {
    const { client } = mockClient(
      [{ product_id: 'p1', tire_size: '90/90-18' }],
      [{ measure: '90/90R18', quantity_on_hand: 10, unit_cost: '21.25' }],
    );
    const map = await getMatrizGalpaoCostByProduct(client, 'test', ['p1']);
    expect(map.get('p1')).toBe(21.25);
  });

  it('duas linhas na mesma chave nao escolhem custo arbitrario', async () => {
    const { client } = mockClient(
      [{ product_id: 'p1', tire_size: '90/90-18' }],
      [
        { measure: '90/90-18', quantity_on_hand: 2, unit_cost: '50' },
        { measure: '90/90R18', quantity_on_hand: 30, unit_cost: '20' }, // maior estoque manda
        { measure: '90/90 - 18', quantity_on_hand: 99, unit_cost: null }, // sem custo não concorre
      ],
    );
    expect((await getMatrizGalpaoCostByProduct(client, 'prod', ['p1'])).has('p1')).toBe(false);
  });

  it('medida sem custo no galpão → produto fica FORA do mapa (não inventa custo)', async () => {
    const { client } = mockClient(
      [{ product_id: 'p1', tire_size: '90/90-18' }],
      [{ measure: '90/90-18', quantity_on_hand: 10, unit_cost: null }],
    );
    expect((await getMatrizGalpaoCostByProduct(client, 'test', ['p1'])).has('p1')).toBe(false);
  });

  it('produto sem medida casável → fora do mapa; lista vazia → nem consulta o banco', async () => {
    const { client } = mockClient([{ product_id: 'p1', tire_size: null }], [
      { measure: '90/90-18', quantity_on_hand: 10, unit_cost: '21' },
    ]);
    expect((await getMatrizGalpaoCostByProduct(client, 'test', ['p1'])).size).toBe(0);

    const query = vi.fn();
    const empty = { query } as unknown as PoolClient;
    expect((await getMatrizGalpaoCostByProduct(empty, 'test', [])).size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('applyMatrizRetailCostSnapshot — congela o custo na venda do varejo da matriz (0117)', () => {
  it('flag off → não toca no banco (byte a byte como hoje)', async () => {
    const query = vi.fn();
    const client = { query } as unknown as PoolClient;
    await applyMatrizRetailCostSnapshot(client, 'test', 'oid', [{ productId: 'p1', quantity: 1 }], false);
    expect(query).not.toHaveBeenCalled();
  });

  it('flag on → UPDATE só nos itens COM custo, e só onde matriz_unit_cost ainda é NULL', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [
        { product_id: 'p1', tire_size: '90/90-18' },
        { product_id: 'p2', tire_size: '150/60-17' }, // medida sem linha no galpão → sem custo
      ] })
      .mockResolvedValueOnce({ rows: [{ measure: '90/90R18', quantity_on_hand: 10, unit_cost: '21.25' }] })
      .mockResolvedValue({ rowCount: 1, rows: [] });
    const client = { query } as unknown as PoolClient;
    await applyMatrizRetailCostSnapshot(
      client, 'test', 'oid-1',
      [{ productId: 'p1', quantity: 2 }, { productId: 'p2', quantity: 1 }],
      true,
    );
    // 2 leituras (specs + galpão) e UM update (só o p1 tem custo)
    expect(query).toHaveBeenCalledTimes(3);
    const [sql, params] = query.mock.calls[2]!;
    expect(String(sql)).toContain('matriz_unit_cost IS NULL'); // retry não sobrescreve
    expect(params).toEqual(['test', 'oid-1', 'p1', 21.25]);
  });

  it('nenhum produto com custo conhecido → nenhum UPDATE', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ product_id: 'p1', tire_size: null }] })
      .mockResolvedValueOnce({ rows: [] });
    const client = { query } as unknown as PoolClient;
    await applyMatrizRetailCostSnapshot(client, 'test', 'oid-2', [{ productId: 'p1', quantity: 1 }], true);
    expect(query).toHaveBeenCalledTimes(2); // só as leituras
  });
});
