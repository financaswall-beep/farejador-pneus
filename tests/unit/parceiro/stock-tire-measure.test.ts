import { describe, expect, it } from 'vitest';
import { partnerScreen } from '../admin/helpers/partner-simple-dom.js';
import { normalizePartnerTireMeasure } from '../../../src/parceiro/stock-tire-measure.js';

describe('medida digitada no cadastro simples', () => {
  const cases: Array<[string, string | null]> = [
    ['909018', '90/90-18'], ['8010014', '80/100-14'], ['1109017', '110/90-17'],
    ['1956515', '195/65-15'], ['10010018', '100/100-18'], [' 195 / 65 R 15 ', '195/65-15'],
    ['90/90-18', '90/90-18'], ['9018', null], ['9090189', null], ['110/90-1', null],
    ['450/50-17', null], ['90/110-18', null], ['90/90-99', null], ['909018abc', null],
    ['2.75-18', null], ['', null], ['0/0-00', null],
  ];
  it.each(cases)('normaliza %s sem inventar dimensões ou tipo do veículo', (input, expected) => {
    const ui = partnerScreen().C.partnerStockFields;
    expect(normalizePartnerTireMeasure(input)).toBe(expected);
    expect(ui.normalizeMeasure(input)).toBe(expected);
  });
});
