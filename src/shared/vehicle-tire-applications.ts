import research from './data/vehicle-tire-research-20260906.json' with { type: 'json' };

// Catálogo público versionado, independente de estoque/SKU. Nunca homologa produto.
export const VEHICLE_APPLICATION_VERSION = 'manufacturer-applications-20260911-v5';
export interface VehicleTireApplication {
  application_id: string;
  make: string;
  model: string;
  year_start: number | null;
  year_end: number | null;
  year_reference: string;
  reference_model: string;
  reference_year_start: number | null;
  reference_year_end: number | null;
  range_source_urls: string[];
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
    const referenceStart = years ? Number(years[1]) : null;
    const referenceEnd = years ? Number(years[2] || years[1]) : null;
    // Vigência comprovada é diferente da edição de um manual. Sem pesquisa
    // adicional, conservamos somente o período explicitado na fonte original.
    const validity = 'applicability' in b ? b.applicability : undefined;
    const positions = [['front', b.front], ['rear', b.rear]] as const;
    return positions.flatMap(([position, spec]) => (spec ? Array.isArray(spec) ? spec : [spec] : [])
      .map(value => {
        const [size = '', index = '', mounting = 'ND'] = value.split('|');
        return {
          application_id: `${b.id}:${position}:${size}`,
          make: b.brand, model: validity?.model ?? b.model,
          year_start: validity?.year_start ?? referenceStart,
          year_end: validity?.year_end ?? referenceEnd,
          year_reference: validity ? `${validity.year_start}–${validity.year_end}` : b.ref,
          reference_model: b.model, reference_year_start: referenceStart, reference_year_end: referenceEnd,
          range_source_urls: validity?.sources ?? [], position, tire_size: size,
          display_measure: applicationMeasureKey(size), index_spec: index || null,
          mounting, source_url: b.url, source_type: b.type,
          source_checked_at: validity?.checked_at ?? ('checked_at' in b ? String(b.checked_at) : '2026-09-06'), notes: b.notes,
          validation_scope: 'manufacturer_measure' as const, product_fitment_confirmed: false as const,
        };
      }));
  });

export function applicationsForMeasure(size: string | null | undefined): VehicleTireApplication[] {
  const key = applicationMeasureKey(size);
  return key ? applications.filter(a => applicationMeasureKey(a.tire_size) === key).map(copyApplication) : [];
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
    const haystack = new Set(tokens(`${a.make} ${a.model} ${a.reference_model}`));
    if (a.make === 'Yamaha' && a.model === 'Fazer FZ25 ABS Connected') haystack.add('250');
    if (!query.every(t => haystack.has(t))) return false;
    if (year && a.year_start !== null && (year < a.year_start || year > a.year_end!)) return false;
    return !position || position === 'both' || a.position === position;
  }).map(copyApplication);
}

function copyApplication(a: VehicleTireApplication): VehicleTireApplication {
  return { ...a, range_source_urls: [...a.range_source_urls] };
}
