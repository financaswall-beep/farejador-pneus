import { describe, expect, it } from 'vitest';
import { catalogApplicationSummary, pendingCatalogMeasures } from '../../../src/admin/painel/catalog-measure-registration.js';
import type { CatalogApplication } from '../../../src/shared/vehicle-application-catalog.js';

const apps = [
  { display_measure: '130/70-13', make: 'Yamaha', model: 'NMAX', position: 'rear', year_start: 2017, year_end: 2022 },
  { display_measure: '130/70-13', make: 'Teste', model: 'Outra moto', position: 'front', year_start: 2024, year_end: 2024 },
] as CatalogApplication[];

describe('pré-cadastro e classificação por aplicação', () => {
  it('não duplica medidas existentes, preservando distinção da medida cintada', () => {
    const rows = pendingCatalogMeasures([{ measure: '140/70-17' }, { measure: '130/70-13' }],
      [{ tire_size: '140/70R17' }, { tire_size: '130/70B13' }], apps);
    expect(rows.map(r => r.tire_size)).toEqual(['130/70-13']);
  });
  it('não inventa condição, marca, posição do SKU, preço ou saldo', () => {
    const [row] = pendingCatalogMeasures([{ measure: '130/70-13' }], [], apps);
    expect(row).toMatchObject({ brand: null, tire_condition: null, tire_position: null,
      price_amount: null, total_stock_available: null, sellable: false,
      application_positions: ['front', 'rear'], application_count: 2 });
    expect(row?.application_search).toContain('NMAX 2017 2022 traseiro');
    expect(apps[0].position).toBe('rear');
  });
  it('não cria classificação sem uma aplicação confirmada', () => {
    expect(catalogApplicationSummary(apps, '180/55-18')).toEqual({ application_count: 0,
      application_positions: [], application_search: '' });
  });
});
