import { describe, expect, it } from 'vitest';
import { requireTireVehicleType } from '../../../src/shared/tire-vehicle-type.js';
import { pendingCatalogMeasures, catalogApplicationSummary } from '../../../src/admin/painel/catalog-measure-registration.js';
import { matchCatalogApplications, type CatalogApplication } from '../../../src/shared/vehicle-application-catalog.js';

const base = { display_measure: '130/70-13', tire_size: '130/70-13', make: 'Marca', model: 'Modelo',
  reference_model: 'Modelo', position: 'rear', year_start: 2020, year_end: 2025 } as CatalogApplication;
describe('classificação explícita, separada da medida', () => {
  it('não presume moto nem aceita classe desconhecida do contrato', () => {
    expect(requireTireVehicleType(undefined)).toBeNull();
    expect(requireTireVehicleType(null)).toBeNull();
    expect(requireTireVehicleType('car')).toBe('car');
    for (const value of ['truck', '130/70-13', 'novo', 'carro', '']) {
      expect(() => requireTireVehicleType(value)).toThrow('catalog_vehicle_type_invalid');
    }
  });
  it('o pré-cadastro de carro não desaparece porque já existe a medida de moto', () => {
    const rows = pendingCatalogMeasures([{ measure: '130/70-13', vehicle_type: 'car' }],
      [{ tire_size: '130/70-13', vehicle_type: 'motorcycle' }], []);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ vehicle_type: 'car', sellable: false });
    expect(pendingCatalogMeasures([{ measure: '130/70-13', vehicle_type: 'car' }],
      [{ tire_size: '130/70-13', vehicle_type: 'car' }], [])).toEqual([]);
  });
  it('aplicações de carro não vazam para a consulta antiga de moto', () => {
    const car = { ...base, vehicle_type: 'car' as const };
    const moto = { ...base, vehicle_type: 'motorcycle' as const };
    const unknown = { ...base, vehicle_type: null };
    expect(matchCatalogApplications([car, moto, unknown], 'Modelo')).toEqual([moto, unknown]);
    expect(matchCatalogApplications([car, moto, unknown], 'Modelo', 2022, 'rear', 'car')).toEqual([car]);
    expect(catalogApplicationSummary([car, moto, unknown], '130/70-13', 'car').application_count).toBe(1);
  });
});
