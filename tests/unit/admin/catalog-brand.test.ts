import { describe, expect, it } from 'vitest';
import { canonicalCatalogBrand } from '../../../src/admin/painel/catalog-brand.js';

describe('marca conciliada entre compra, estoque e catalogo', () => {
  it('padroniza marcas homologadas e preserva marca futura', () => {
    expect(canonicalCatalogBrand('  MICHELIN ')).toBe('Michelin');
    expect(canonicalCatalogBrand('Magion')).toBe('Maggion');
    expect(canonicalCatalogBrand('Ira')).toBe('IRA');
    expect(canonicalCatalogBrand('irc')).toBe('IRC');
    expect(canonicalCatalogBrand('Ciat')).toBe('CEAT');
    for (const brand of ['Maxxis', 'Hankook', 'Toyo', 'XBRI', 'Yokohama', 'Giti']) {
      expect(canonicalCatalogBrand(brand.toLowerCase())).toBe(brand);
    }
    expect(canonicalCatalogBrand('Toyo Tires')).toBe('Toyo');
    expect(canonicalCatalogBrand('Marca   Nova')).toBe('Marca Nova');
    expect(canonicalCatalogBrand('  ')).toBeNull();
  });
});
