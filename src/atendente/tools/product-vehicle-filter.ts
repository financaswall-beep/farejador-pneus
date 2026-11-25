import type { TireVehicleType } from '../../shared/tire-vehicle-type.js';

/** O catálogo anterior à classificação inclui pneus de moto com tipo nulo. */
export function productVehicleFilter(type?: TireVehicleType): string {
  if (type === 'car') return "ts.vehicle_type = 'car'";
  if (type === 'motorcycle') return "ts.vehicle_type IS DISTINCT FROM 'car'";
  return 'TRUE';
}
