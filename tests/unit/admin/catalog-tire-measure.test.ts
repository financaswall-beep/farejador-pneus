import { describe, expect, it } from 'vitest';
import { parseCatalogTireMeasure } from '../../../src/admin/painel/catalog-tire-measure.js';

describe('medida mestre do Catálogo', () => {
  it('normaliza medidas métricas e em polegadas sem trocar o significado', () => {
    expect(parseCatalogTireMeasure(' 90 / 90 R 18 ')).toEqual({
      canonical: '90/90-18', key: '90-90-18', widthMm: 90,
      aspectRatio: 90, rimDiameter: 18,
    });
    expect(parseCatalogTireMeasure('3,0-18')).toEqual({
      canonical: '3.00-18', key: '300-18', widthMm: null,
      aspectRatio: null, rimDiameter: 18,
    });
  });

  it('falha fechada para medida parcial, texto livre ou dimensão impossível', () => {
    expect(parseCatalogTireMeasure('90/90')).toBeNull();
    expect(parseCatalogTireMeasure('pneu 90/90-18 traseiro')).toBeNull();
    expect(parseCatalogTireMeasure('900/10-99')).toBeNull();
  });
});
