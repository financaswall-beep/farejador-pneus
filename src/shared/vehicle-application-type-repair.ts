import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { APPLICATION_BATCH, verifiedMotorcycleImport } from './vehicle-application-import-verified.js';
import type { CatalogApplication } from './vehicle-application-catalog.js';
import { applicationMeasureKey } from './vehicle-tire-applications.js';

const known = new Map(verifiedMotorcycleImport()
  .filter(row => row.status === 'verified' && row.kind === 'original' && row.application.vehicle_type === 'motorcycle')
  .map(({ application }) => [application.application_id, application]));
export type MotorcycleReference = Pick<CatalogApplication, 'application_id' | 'make' | 'model' | 'position' | 'year_start' | 'year_end' | 'source_url'>;
type ImportedRow = Omit<MotorcycleReference, 'source_url'> & Pick<CatalogApplication, 'display_measure' | 'tire_size'> & {reference: CatalogApplication};
export type ClassificationSelection = { applicationIds: string[]; actor: string };

/** Repara apenas referências originais já verificadas da pesquisa de motos conhecida.
 * Não deduz categoria pela medida, não promove propostas e não homologa SKUs.
 * O chamador controla a transação e a autorização para persistir.
 */
export async function repairVehicleApplicationTypes(
  client: Pick<PoolClient, 'query'>, environment: 'prod' | 'test', measure: string, commit: boolean | ClassificationSelection = false,
) {
  const key = applicationMeasureKey(measure);
  if (!key) throw new Error('invalid_measure');
  const rows = (await client.query<ImportedRow>(`SELECT * FROM commerce.vehicle_measure_applications
    WHERE environment=$1 AND display_measure=$2 AND vehicle_type IS NULL
      AND status='verified' AND application_kind='original' AND import_batch=$3
    ORDER BY application_id ${commit ? 'FOR UPDATE' : ''}`, [environment, key, APPLICATION_BATCH])).rows;
  const fields = ['make', 'model', 'position', 'tire_size', 'display_measure', 'year_start', 'year_end'] as const;
  const eligible = rows.filter(row => {
    const source = known.get(row.application_id);
    return source && fields.every(field => row[field] === source[field])
      && (row.reference?.vehicle_type == null || row.reference.vehicle_type === 'motorcycle')
      && row.reference?.source_url === source.source_url;
  });
  const skipped = rows.filter(row => !eligible.includes(row)).map(row => row.application_id);
  const selection = typeof commit === 'object' ? new Set(commit.applicationIds) : null;
  const selected = selection ? eligible.filter(row => selection.has(row.application_id)) : eligible;
  if (selection && (!selection.size || selected.length !== selection.size)) {
    throw new Error('catalog_reference_selection_changed');
  }
  const actor = typeof commit === 'object' ? commit.actor : 'Correção de classificação de aplicações confirmadas';
  for (const row of commit ? selected : []) {
    const updated = await client.query(`UPDATE commerce.vehicle_measure_applications SET vehicle_type='motorcycle'
      WHERE environment=$1 AND application_id=$2 AND vehicle_type IS NULL RETURNING application_id`,
    [environment, row.application_id]);
    if (updated.rowCount !== 1) throw new Error('application_changed_during_repair');
    await client.query(`INSERT INTO audit.events
      (environment,domain,entity_table,entity_id,event_type,actor_label,payload_before,payload_after)
      VALUES ($1,'catalog','commerce.vehicle_measure_applications',$2,'catalog_application_vehicle_type_repaired',
        $3,$4::jsonb,$5::jsonb)`,
    [environment, randomUUID(), actor, JSON.stringify(row), JSON.stringify({ ...row, vehicle_type: 'motorcycle',
      repair_source: APPLICATION_BATCH, reason: 'Restaurar classificação da pesquisa de motos após introdução do filtro de categoria.' })]);
  }
  return { environment, measure: key, changed: commit ? selected.length : 0, skipped,
    applications: selected.map((row): MotorcycleReference => ({ application_id: row.application_id, make: row.make, model: row.model,
      position: row.position, year_start: row.year_start, year_end: row.year_end, source_url: row.reference.source_url })) };
}
