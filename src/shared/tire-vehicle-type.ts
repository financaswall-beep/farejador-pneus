import { z } from 'zod';

/** Categoria comercial confirmada; não representa condição nem compatibilidade. */
export const tireVehicleTypeSchema = z.enum(['motorcycle', 'car']);
export type TireVehicleType = z.infer<typeof tireVehicleTypeSchema>;
export const tireVehicleFilterSchema = z.enum(['all', 'motorcycle', 'car', 'unknown']);
export type TireVehicleFilter = z.infer<typeof tireVehicleFilterSchema>;
export const vehicleReportFilterSchema = z.enum(['all', 'motorcycle', 'car', 'unknown', 'mixed']);
export type VehicleReportFilter = z.infer<typeof vehicleReportFilterSchema>;

export function requireTireVehicleType(value: unknown): TireVehicleType | null {
  if (value === undefined || value === null) return null;
  const parsed = tireVehicleTypeSchema.safeParse(value);
  if (!parsed.success) throw new Error('catalog_vehicle_type_invalid');
  return parsed.data;
}

export function matchesTireVehicleType(
  value: string | null | undefined, filter: VehicleReportFilter = 'all',
): boolean {
  return filter === 'all' || (filter === 'unknown' ? value == null : value === filter);
}

export function tireVehicleLabel(value?: string | null): string {
  return ({ all:'Todos os pneus', motorcycle:'Moto', car:'Carro', mixed:'Lotes mistos' } as Record<string,string>)[value ?? 'unknown'] ?? 'Não identificado';
}
