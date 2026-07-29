import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import {
  canonicalCatalogBrand,
  syncCatalogBrandForMeasure,
} from '../../../src/admin/painel/catalog-brand.js';

describe('marca conciliada entre compra, estoque e catalogo', () => {
  it('padroniza marcas homologadas e preserva marca futura', () => {
    expect(canonicalCatalogBrand('  MICHELIN ')).toBe('Michelin');
    expect(canonicalCatalogBrand('Magion')).toBe('Maggion');
    expect(canonicalCatalogBrand('Marca   Nova')).toBe('Marca Nova');
    expect(canonicalCatalogBrand('  ')).toBeNull();
  });

  it('atualiza todos os produtos da medida e deixa auditoria por produto', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT p.id,p.brand')) {
        return { rows: [{ id: 'p1', brand: null }, { id: 'p2', brand: null }] };
      }
      if (sql.includes('UPDATE commerce.products')) return { rows: [] };
      if (sql.includes('INSERT INTO audit.events')) return { rows: [] };
      throw new Error(`consulta inesperada: ${sql}`);
    });

    await expect(syncCatalogBrandForMeasure({ query } as unknown as PoolClient, {
      environment: 'test',
      measure: '90/90-18',
      brand: 'michelin',
      actorLabel: 'Operador',
    })).resolves.toBe('Michelin');

    expect(query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO audit.events')))
      .toHaveLength(2);
    const update = query.mock.calls.find(([sql]) => String(sql).includes('UPDATE commerce.products'));
    expect(update?.[1]).toEqual(['test', ['p1', 'p2'], 'Michelin']);
  });

  it('recusa misturar outra marca na mesma medida quando ainda existe saldo', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT p.id,p.brand')) return { rows: [{ id: 'p1', brand: 'Michelin' }] };
      if (sql.includes('FROM commerce.wholesale_stock')) return { rows: [{ quantity_on_hand: 4 }] };
      return { rows: [] };
    });

    await expect(syncCatalogBrandForMeasure({ query } as unknown as PoolClient, {
      environment: 'test',
      measure: '90/90-18',
      brand: 'Pirelli',
    })).rejects.toThrow('stock_measure_brand_conflict');
    expect(query.mock.calls.some(([sql]) => String(sql).includes('UPDATE commerce.products'))).toBe(false);
  });
});
