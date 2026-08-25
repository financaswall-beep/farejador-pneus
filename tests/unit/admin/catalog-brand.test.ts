import { describe, expect, it } from 'vitest';
import { canonicalCatalogBrand } from '../../../src/admin/painel/catalog-brand.js';

describe('marca conciliada entre compra, estoque e catalogo', () => {
  it('padroniza marcas homologadas e preserva marca futura', () => {
    expect(canonicalCatalogBrand('  MICHELIN ')).toBe('Michelin');
    expect(canonicalCatalogBrand('Magion')).toBe('Maggion');
    expect(canonicalCatalogBrand('Ira')).toBe('IRA');
    expect(canonicalCatalogBrand('irc')).toBe('IRC');
    expect(canonicalCatalogBrand('Ciat')).toBe('CEAT');
    expect(canonicalCatalogBrand('Marca   Nova')).toBe('Marca Nova');
    expect(canonicalCatalogBrand('  ')).toBeNull();
  });
});
