import { z } from 'zod';

/** Categoria comercial confirmada; não representa condição nem compatibilidade. */
export const tireVehicleTypeSchema = z.enum(['motorcycle', 'car']);
export type TireVehicleType = z.infer<typeof tireVehicleTypeSchema>;
export const tireVehicleFilterSchema = z.enum(['all', 'motorcycle', 'car', 'unknown']);
export type TireVehicleFilter = z.infer<typeof tireVehicleFilterSchema>;

export function requireTireVehicleType(value: unknown): TireVehicleType | null {
  if (value === undefined || value === null) return null;
  const parsed = tireVehicleTypeSchema.safeParse(value);
  if (!parsed.success) throw new Error('catalog_vehicle_type_invalid');
  return parsed.data;
}

export function matchesTireVehicleType(
  value: TireVehicleType | null | undefined, filter: TireVehicleFilter = 'all',
): boolean {
  return filter === 'all' || (filter === 'unknown' ? value == null : value === filter);
}
