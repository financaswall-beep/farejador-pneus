import type { Pool } from 'pg';
import { demandReportQuery } from './demand-report-filter.js';
import { readDemandSnapshot } from './demand-report-data.js';
import { buildDemandReport } from './queries-demand-report.js';
import { DEMAND_UNKNOWN } from './demand-report-types.js';
import type { VehicleReportFilter } from '../../shared/tire-vehicle-type.js';
import type { PainelRedePeriod } from './queries-pedidos.js';

/** The Bot demand tab and Reports use the same per-item evidence and deduplication. */
export async function getBotVehicleDemand(period: PainelRedePeriod, vehicleType: VehicleReportFilter,
  environment: 'prod' | 'test', db: Pool) {
  const { rows } = await db.query<{ today: string }>("SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date::text today");
  const to = rows[0]!.today, start = new Date(to + 'T12:00:00Z');
  if (period === 'today') { /* Today only. */ }
  else if (period === '7d' || period === '30d') start.setUTCDate(start.getUTCDate() - (period === '7d' ? 6 : 29));
  else start.setUTCDate(1);
  const filter = demandReportQuery.parse({ from: start.toISOString().slice(0, 10), to,
    compare: 'false', vehicle_type: vehicleType });
  const snapshot = await readDemandSnapshot(filter, environment, db);
  const report = buildDemandReport(snapshot, filter);
  return {
    mapa: report.cities.filter(city => city.key !== DEMAND_UNKNOWN).map(city => ({ municipio: city.name,
      chamou: city.conversations, pediu: city.orders, efetivou: city.deliveries, faltou: city.shortages })),
    sem_regiao: report.summary.unidentified, demanda_disponivel: true,
    medidas_por_municipio: report.cities.filter(city => city.key !== DEMAND_UNKNOWN).flatMap(city =>
      buildDemandReport(snapshot, { ...filter, city: city.key }).measures.map(measure => ({
        municipio: city.name, medida: measure.measure, consultas: measure.consultations, galpao_qty: measure.stock,
      }))),
  };
}
