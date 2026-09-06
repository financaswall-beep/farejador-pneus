import { applicationsForMeasure, VEHICLE_APPLICATION_VERSION }
  from '../../shared/vehicle-tire-applications.js';

interface ResearchDiscovery {
  status: string;
  discovery_origin: string;
  discovery_measure: string;
  make: string;
  model: string;
  variant: string | null;
  year_start: number | null;
  year_end: number | null;
  position: string;
  source_url: string | null;
  notes: string | null;
}

// Metadado de LEITURA: não aprova o SKU e não altera/reabre decisões humanas.
// Só reconhece cópias exatas do lote pesquisado já incluído na base de consulta.
export function activeResearchReference(row: ResearchDiscovery) {
  if (row.status !== 'pending' || row.discovery_origin !== 'web_research' || row.variant) return null;
  const reference = applicationsForMeasure(row.discovery_measure).find(app => {
    const researchId = app.application_id.split(':')[0];
    const sourceKey = `${researchId}:${app.position === 'front' ? 'Dianteiro' : 'Traseiro'}:${app.tire_size}`;
    return row.notes?.startsWith(`catalog-fitment-research-20260906-v1; ${sourceKey};`)
      && row.make === app.make && row.model === app.model && row.position === app.position
      && row.year_start === app.year_start && row.year_end === app.year_end
      && row.source_url === app.source_url;
  });
  return reference ? {
    application_id: reference.application_id,
    catalog_version: VEHICLE_APPLICATION_VERSION,
    scope: 'manufacturer_measure' as const,
    product_fitment_confirmed: false as const,
  } : null;
}
