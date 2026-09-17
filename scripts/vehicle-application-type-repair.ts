import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { APPLICATION_BATCH, buildApplicationImport } from './vehicle-application-import.js';
import { applicationMeasureKey } from '../src/shared/vehicle-tire-applications.js';

/** Repara apenas referências originais já verificadas da pesquisa de motos conhecida.
 * Não deduz categoria pela medida, não promove propostas e não homologa SKUs.
 * O chamador controla a transação e a autorização para persistir.
 */
export async function repairVehicleApplicationTypes(
  client: Pick<PoolClient, 'query'>, environment: 'prod' | 'test', measure: string, commit = false,
) {
  const key = applicationMeasureKey(measure);
  if (!key) throw new Error('invalid_measure');
  const known = new Map(buildApplicationImport().filter(r => r.status === 'verified'
    && r.kind === 'original' && r.application.vehicle_type === 'motorcycle'
    && r.application.display_measure === key).map(r => [r.application.application_id, r.application]));
  const rows = (await client.query(`SELECT * FROM commerce.vehicle_measure_applications
    WHERE environment=$1 AND display_measure=$2 AND vehicle_type IS NULL
      AND status='verified' AND application_kind='original' AND import_batch=$3
    ORDER BY application_id ${commit ? 'FOR UPDATE' : ''}`, [environment, key, APPLICATION_BATCH])).rows;
  const fields = ['make', 'model', 'position', 'tire_size', 'display_measure', 'year_start', 'year_end'] as const;
  const eligible = rows.filter(row => {
    const source = known.get(row.application_id);
    return source && fields.every(field => row[field] === source[field])
      && row.reference?.source_url === source.source_url;
  });
  const skipped = rows.filter(row => !eligible.includes(row)).map(row => row.application_id);
  for (const row of commit ? eligible : []) {
    const updated = await client.query(`UPDATE commerce.vehicle_measure_applications SET vehicle_type='motorcycle'
      WHERE environment=$1 AND application_id=$2 AND vehicle_type IS NULL RETURNING application_id`,
    [environment, row.application_id]);
    if (updated.rowCount !== 1) throw new Error('application_changed_during_repair');
    await client.query(`INSERT INTO audit.events
      (environment,domain,entity_table,entity_id,event_type,actor_label,payload_before,payload_after)
      VALUES ($1,'catalog','commerce.vehicle_measure_applications',$2,'catalog_application_vehicle_type_repaired',
        'Correção de classificação de aplicações confirmadas',$3::jsonb,$4::jsonb)`,
    [environment, randomUUID(), JSON.stringify(row), JSON.stringify({ ...row, vehicle_type: 'motorcycle',
      repair_source: APPLICATION_BATCH, reason: 'Restaurar classificação da pesquisa de motos após introdução do filtro de categoria.' })]);
  }
  return { environment, measure: key, changed: commit ? eligible.length : 0, skipped,
    applications: eligible.map(row => ({ application_id: row.application_id, make: row.make, model: row.model,
      position: row.position, year_start: row.year_start, year_end: row.year_end, source_url: row.reference.source_url })) };
}
