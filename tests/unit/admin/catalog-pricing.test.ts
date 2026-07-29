import { describe, expect, it, vi } from 'vitest';
import {
  assertCurrentCatalogPrices,
  loadCurrentCatalogPrices,
  loadCurrentPartnerPrices,
  moneyCents,
} from '../../../src/shared/catalog-pricing.js';

describe('preco oficial central do catalogo', () => {
  it('normaliza o preco atual em um mapa por produto', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{
        product_id: 'produto-1',
        price_amount: '139.90',
        price_type: 'matriz',
        currency: 'BRL',
      }],
    });

    const prices = await loadCurrentCatalogPrices({ query } as never, 'test', ['produto-1', 'produto-1']);

    expect(prices.get('produto-1')).toEqual({
      product_id: 'produto-1',
      price_amount: 139.9,
      price_type: 'matriz',
      currency: 'BRL',
    });
    expect(query.mock.calls[0]?.[1]).toEqual(['test', ['produto-1']]);
  });

  it('mantem a consulta dos parceiros na tabela regular antiga', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{
        product_id: 'produto-1',
        price_amount: '149.90',
        price_type: 'regular',
        currency: 'BRL',
      }],
    });

    const prices = await loadCurrentPartnerPrices({ query } as never, 'prod', ['produto-1']);

    expect(prices.get('produto-1')?.price_amount).toBe(149.9);
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain('FROM commerce.product_prices');
    expect(sql).toContain("price_type='regular'");
    expect(sql).not.toContain('matriz_current_prices');
  });

  it('aceita somente o mesmo valor vigente ate os centavos', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{
        product_id: 'produto-1',
        price_amount: '129.90',
        price_type: 'regular',
        currency: 'BRL',
      }],
    });

    await expect(assertCurrentCatalogPrices(
      { query } as never,
      'prod',
      [{ product_id: 'produto-1', unit_price: 129.9 }],
    )).resolves.toBeUndefined();
    expect(moneyCents(129.8999999)).toBe(12990);
  });

  it('bloqueia preco desatualizado e produto sem preco', async () => {
    const changedQuery = vi.fn().mockResolvedValue({
      rows: [{
        product_id: 'produto-1',
        price_amount: '139.90',
        price_type: 'regular',
        currency: 'BRL',
      }],
    });
    await expect(assertCurrentCatalogPrices(
      { query: changedQuery } as never,
      'test',
      [{ product_id: 'produto-1', unit_price: 129.9 }],
    )).rejects.toThrow('catalog_price_changed');

    const missingQuery = vi.fn().mockResolvedValue({ rows: [] });
    await expect(assertCurrentCatalogPrices(
      { query: missingQuery } as never,
      'test',
      [{ product_id: 'produto-2', unit_price: 129.9 }],
    )).rejects.toThrow('catalog_price_missing');
  });
});
