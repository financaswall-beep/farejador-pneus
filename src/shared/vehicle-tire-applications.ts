import research from './data/vehicle-tire-research-20260906.json' with { type: 'json' };

// Catálogo público versionado, independente de estoque/SKU. Nunca homologa produto.
export const VEHICLE_APPLICATION_VERSION = 'manufacturer-applications-20260906-v1';
export interface VehicleTireApplication {
  application_id: string;
  make: string;
  model: string;
  year_start: number | null;
  year_end: number | null;
  year_reference: string;
  position: 'front' | 'rear';
  tire_size: string;
  display_measure: string;
  index_spec: string | null;
  mounting: string;
  source_url: string;
  source_type: string;
  source_checked_at: string;
  notes: string;
  validation_scope: 'manufacturer_measure';
  product_fitment_confirmed: false;
}

// R/ZR compartilham dimensão nominal, não construção. B e polegadas preservados.
export function applicationMeasureKey(value: string | null | undefined): string {
  const text = (value ?? '').toUpperCase().replace(/\s+/g, '');
  const metric = text.match(/^(\d+)\/(\d+)(ZR|R|B|-)(\d+)$/);
  if (metric) return `${metric[1]}/${metric[2]}${metric[3] === 'B' ? 'B' : '-'}${metric[4]}`;
  return /^\d+\.\d+-\d+$/.test(text) ? text : '';
}

const applications: ReadonlyArray<VehicleTireApplication> = research
  .filter(b => b.market === 'Brasil' && b.status === 'Medida confirmada na fonte')
  .flatMap(b => {
    const years = b.ref.match(/^(\d{4})(?:[–-](\d{4}))?$/);
    const positions = [['front', b.front], ['rear', b.rear]] as const;
    return positions.flatMap(([position, spec]) => (spec ? Array.isArray(spec) ? spec : [spec] : [])
      .map(value => {
        const [size = '', index = '', mounting = 'ND'] = value.split('|');
        return {
          application_id: `${b.id}:${position}:${size}`,
          make: b.brand, model: b.model,
          year_start: years ? Number(years[1]) : null,
          year_end: years ? Number(years[2] || years[1]) : null,
          year_reference: b.ref, position, tire_size: size,
          display_measure: applicationMeasureKey(size), index_spec: index || null,
          mounting, source_url: b.url, source_type: b.type,
          source_checked_at: '2026-09-06', notes: b.notes,
          validation_scope: 'manufacturer_measure' as const, product_fitment_confirmed: false as const,
        };
      }));
  });

export function applicationsForMeasure(size: string | null | undefined): VehicleTireApplication[] {
  const key = applicationMeasureKey(size);
  return key ? applications.filter(a => applicationMeasureKey(a.tire_size) === key).map(a => ({ ...a })) : [];
}

function tokens(value: string): string[] {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z])/g, '$1 $2')
    .split(/[^a-z0-9]+/).filter(Boolean);
}

export function applicationsForMotorcycle(
  model: string, year?: number, position?: 'front' | 'rear' | 'both',
): VehicleTireApplication[] {
  const query = tokens(model);
  if (query.length === 0) return [];
  return applications.filter(a => {
    const haystack = new Set(tokens(`${a.make} ${a.model}`));
    if (a.make === 'Yamaha' && a.model === 'Fazer FZ25 ABS Connected') haystack.add('250');
    if (!query.every(t => haystack.has(t))) return false;
    if (year && a.year_start !== null && (year < a.year_start || year > a.year_end!)) return false;
    return !position || position === 'both' || a.position === position;
  }).map(a => ({ ...a }));
}
