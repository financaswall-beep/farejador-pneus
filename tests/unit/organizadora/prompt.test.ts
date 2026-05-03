import { describe, expect, it } from 'vitest';
import {
  buildAllowedValuesSection,
  EXTRACTOR_VERSION,
  SCHEMA_VERSION,
} from '../../../src/organizadora/prompt.js';

describe('buildAllowedValuesSection', () => {
  const section = buildAllowedValuesSection();

  it('lists every forma_pagamento enum value the schema accepts', () => {
    expect(section).toContain(
      '- forma_pagamento: pix | cartao_credito | cartao_debito | dinheiro | boleto | indefinido',
    );
  });

  it('lists modalidade_entrega without aliases like retirada_na_loja', () => {
    expect(section).toContain('- modalidade_entrega: entrega | retirada | indefinido');
    expect(section).not.toContain('retirada_na_loja');
  });

  it('flags moto_cilindrada as integer (not string)', () => {
    expect(section).toContain('- moto_cilindrada: numero inteiro (nao string)');
  });

  it('flags concorrente_citado as free text (not boolean)', () => {
    expect(section).toContain('- concorrente_citado: texto livre (nao boolean, nao numero)');
  });

  it('lists posicao_pneu enum without inventing values', () => {
    expect(section).toContain('- posicao_pneu: dianteiro | traseiro | ambos');
  });
});

describe('prompt versioning', () => {
  it('keeps schema version on moto-pneus-v1', () => {
    expect(SCHEMA_VERSION).toBe('moto-pneus-v1');
  });

  it('bumps extractor version to v3-4 after taxonomy section', () => {
    expect(EXTRACTOR_VERSION).toBe('moto-pneus-hybrid-v3-4');
  });
});
