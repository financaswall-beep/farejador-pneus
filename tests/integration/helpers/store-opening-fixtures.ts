import type { Pool } from 'pg';
import type { Environment } from '../../../src/shared/types/chatwoot.js';
import { withStoreOpeningContext } from '../../../src/atendente-v2/routing-store-hours.js';
import { MATRIZ_COORD } from '../../../src/atendente-v2/matriz-freight.js';

export const testOpeningHours = [1, 2, 3, 4, 5].map(day => ({ day, opens_at: '08:00', closes_at: '18:00' }));
// Controla apenas a avaliação do horário; TTLs, relógio SQL e concorrência continuam reais.
export function atOpenStoreTime<T>(run: () => Promise<T>, environment: Environment = 'test'): Promise<T> {
  return withStoreOpeningContext(environment, run, new Date('2026-10-12T15:00:00Z'));
}

export async function configureTestOpeningHours(pool: Pool, unitId?: string): Promise<void> {
  if (unitId) {
    await pool.query(`UPDATE network.partner_units SET opening_hours_weekly=$2::jsonb
      WHERE environment='test' AND unit_id=$1`, [unitId, JSON.stringify(testOpeningHours)]);
    return;
  }
  await pool.query(`INSERT INTO commerce.matriz_delivery_settings(environment,settings,version,updated_by)
    VALUES('test',$1::jsonb,1,'fixture') ON CONFLICT(environment)
    DO UPDATE SET settings=EXCLUDED.settings,version=commerce.matriz_delivery_settings.version+1`, [JSON.stringify({
    delivery_enabled: true, pickup_enabled: true, radius_km: 55, address: 'Endereço fictício de teste',
    latitude: MATRIZ_COORD.lat, longitude: MATRIZ_COORD.lng, days: [1, 2, 3, 4, 5],
    opens_at: '08:00', closes_at: '18:00', delivery_days: 1, store_hours: testOpeningHours,
  })]);
}
