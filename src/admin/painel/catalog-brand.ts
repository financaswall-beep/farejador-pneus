const KNOWN_BRANDS = new Map<string, string>([
  ['pirelli', 'Pirelli'],
  ['metzeler', 'Metzeler'],
  ['michelin', 'Michelin'],
  ['bridgestone', 'Bridgestone'],
  ['dunlop', 'Dunlop'],
  ['levorin', 'Levorin'],
  ['rinaldi', 'Rinaldi'],
  ['maggion', 'Maggion'],
  ['magion', 'Maggion'],
  ['technic', 'Technic'],
  ['vipal', 'Vipal'],
  ['mitas', 'Mitas'],
  ['kenda', 'Kenda'],
  ['ira', 'IRA'],
  ['irc', 'IRC'],
  ['ceat', 'CEAT'],
  ['ciat', 'CEAT'],
]);

function brandKey(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/** Padroniza as marcas conhecidas sem impedir uma marca nova de entrar no catálogo. */
export function canonicalCatalogBrand(value: string | null | undefined): string | null {
  const clean = value?.trim().replace(/\s+/g, ' ') ?? '';
  if (!clean) return null;
  return KNOWN_BRANDS.get(brandKey(clean)) ?? clean.slice(0, 60);
}
