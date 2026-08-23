export interface CatalogTireMeasure {
  canonical: string;
  key: string;
  widthMm: number | null;
  aspectRatio: number | null;
  rimDiameter: number;
}

function validRim(value: number): boolean {
  return Number.isInteger(value) && value >= 8 && value <= 30;
}

/**
 * Normaliza apenas os formatos de medida que o Catálogo sabe interpretar sem
 * ambiguidade. A regra é deliberadamente mais estrita que tireSizeKey porque
 * este valor vira dado mestre usado por Compras, Estoque, Caixa e Bot.
 */
export function parseCatalogTireMeasure(value: string): CatalogTireMeasure | null {
  const normalized = value.trim().replace(/\s+/g, '').replace(',', '.');
  const metric = normalized.match(/^(\d{2,3})\/(\d{2,3})(?:-|R)(\d{2})$/i);
  if (metric) {
    const widthMm = Number(metric[1]);
    const aspectRatio = Number(metric[2]);
    const rimDiameter = Number(metric[3]);
    if (widthMm < 50 || widthMm > 400 || aspectRatio < 20 || aspectRatio > 100
      || !validRim(rimDiameter)) return null;
    return {
      canonical: `${widthMm}/${aspectRatio}-${rimDiameter}`,
      key: `${widthMm}-${aspectRatio}-${rimDiameter}`,
      widthMm,
      aspectRatio,
      rimDiameter,
    };
  }

  const inch = normalized.match(/^(\d(?:\.\d{1,2}))(?:-|R)(\d{2})$/i);
  if (inch) {
    const widthInches = Number(inch[1]);
    const rimDiameter = Number(inch[2]);
    if (widthInches < 1.5 || widthInches > 8 || !validRim(rimDiameter)) return null;
    const width = widthInches.toFixed(2);
    return {
      canonical: `${width}-${rimDiameter}`,
      key: `${width.replace('.', '')}-${rimDiameter}`,
      widthMm: null,
      aspectRatio: null,
      rimDiameter,
    };
  }
  return null;
}
