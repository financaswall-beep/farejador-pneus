import type { Pool, PoolClient } from 'pg';
import { applicationMeasureKey, type VehicleTireApplication } from './vehicle-tire-applications.js';

export interface CatalogApplication extends VehicleTireApplication {
  aliases?: string[];
  // Revisão explícita da família: uma única edição não comprova todos os anos.
  year_optional?: boolean;
}
type CatalogRow = Pick<CatalogApplication, 'application_id' | 'make' | 'model' | 'aliases' |
  'position' | 'tire_size' | 'display_measure' | 'year_start' | 'year_end'> & {
  reference: VehicleTireApplication;
};

export async function loadVehicleApplicationCatalog(
  db: Pick<Pool | PoolClient, 'query'>, environment: 'prod' | 'test', measure?: string | null,
): Promise<CatalogApplication[]> {
  const key = measure === undefined ? null : applicationMeasureKey(measure);
  if (key === '') return [];
  const result = await db.query<CatalogRow>(`SELECT application_id,make,model,aliases,
      position,tire_size,display_measure,year_start,year_end,reference
    FROM commerce.vehicle_measure_applications
    WHERE environment=$1 AND status='verified' AND application_kind='original'
      AND ($2::text IS NULL OR display_measure=$2)
    ORDER BY make,model,year_start NULLS LAST,position,application_id`, [environment, key]);
  return result.rows.map(({ reference, ...row }) => ({ ...reference, ...row,
    validation_scope: 'manufacturer_measure', product_fitment_confirmed: false,
  }));
}

function tokens(value: string): string[] {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z])/g, '$1 $2')
    .split(/[^a-z0-9]+/).filter(Boolean);
}

export function matchCatalogApplications(
  catalog: CatalogApplication[], model: string, year?: number, position?: 'front' | 'rear' | 'both',
): CatalogApplication[] {
  const query = tokens(model);
  if (!query.length) return [];
  return catalog.filter(row => {
    // Cada alias é uma identificação completa; não juntar tokens de variantes distintas.
    const names = [row.model, row.reference_model, ...(row.aliases ?? [])];
    if (!names.some(name => {
      const haystack = new Set(tokens(`${row.make} ${name}`));
      return query.every(t => haystack.has(t));
    })) return false;
    if (position && position !== 'both' && row.position !== position) return false;
    if (year !== undefined) {
      if (row.year_start !== null && year < row.year_start) return false;
      if (row.year_end !== null && year > row.year_end) return false;
    }
    return true;
  });
}
