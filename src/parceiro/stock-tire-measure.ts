import { parseCatalogTireMeasure } from '../admin/painel/catalog-tire-measure.js';

/** Aceita dígitos corridos somente quando há uma única medida métrica válida. */
export function normalizePartnerTireMeasure(value: string): string | null {
  const text = value.trim().replace(/\s+/g, '');
  const candidates = /^\d{6,8}$/.test(text)
    ? [2, 3].flatMap(width => [2, 3].filter(profile => width + profile + 2 === text.length)
      .map(profile => `${text.slice(0, width)}/${text.slice(width, width + profile)}-${text.slice(-2)}`))
    : [text];
  const canonical = [...new Set(candidates.map(parseCatalogTireMeasure)
    .filter(parsed => parsed?.widthMm != null && parsed.aspectRatio != null)
    .map(parsed => parsed!.canonical))];
  return canonical.length === 1 ? canonical[0]! : null;
}
