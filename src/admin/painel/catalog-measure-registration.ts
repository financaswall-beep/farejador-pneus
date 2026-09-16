import type { CatalogApplication } from '../../shared/vehicle-application-catalog.js';
import { applicationMeasureKey } from '../../shared/vehicle-tire-applications.js';
import type { TireVehicleType } from '../../shared/tire-vehicle-type.js';

// Aplicação é uma relação com a moto, não uma especificação do SKU.
export function catalogApplicationSummary(applications: CatalogApplication[], measure: string | null,
  vehicleType?: TireVehicleType | null) {
  const matches = applications.filter(a => a.display_measure === applicationMeasureKey(measure)
    && (!vehicleType || a.vehicle_type === vehicleType));
  return {
    application_count: matches.length,
    application_positions: [...new Set(matches.map(a => a.position))].sort(),
    application_search: matches.map(a => [a.make, a.model, ...(a.aliases ?? []),
      a.year_start, a.year_end, a.position === 'front' ? 'dianteiro' : 'traseiro'].join(' ')).join(' '),
  };
}

export function pendingCatalogMeasures(
  measures: Array<{ measure: string; vehicle_type?: TireVehicleType | null }>,
  existing: Array<{ tire_size: string | null; vehicle_type?: TireVehicleType | null }>,
  applications: CatalogApplication[],
) {
  const known = new Set(existing.map(row => applicationMeasureKey(row.tire_size)));
  const classified = new Set(existing.map(row => `${applicationMeasureKey(row.tire_size)}:${row.vehicle_type ?? ''}`));
  return measures.filter(row => row.vehicle_type
    ? !classified.has(`${applicationMeasureKey(row.measure)}:${row.vehicle_type}`)
    : !known.has(applicationMeasureKey(row.measure))).map(({ measure, vehicle_type }) => ({
    product_id: null, product_code: null, product_name: `Pneu ${measure}`, product_type: 'tire',
    brand: null, tire_condition: null, tire_size: measure, tire_position: null,
    vehicle_type: vehicle_type ?? null,
    measure_draft: true, catalogued: false, row_key: `measure:${measure}${vehicle_type ? `:${vehicle_type}` : ''}`,
    price_amount: null, official_quantity_on_hand: null, official_quantity_reserved: null,
    total_stock_available: null, official_unit_cost: null, gross_profit: null, margin_percent: null,
    sellable: false, block_reason: 'catalog_registration_incomplete',
    compatibility_count: 0, ...catalogApplicationSummary(applications, measure, vehicle_type),
  }));
}
