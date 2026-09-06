import { describe, expect, it } from 'vitest';
import { activeResearchReference } from '../../../src/admin/painel/catalog-discovery-reference.js';
import { applicationsForMotorcycle } from '../../../src/shared/vehicle-tire-applications.js';

const app = applicationsForMotorcycle('CB250F', 2019, 'rear')[0]!;
const candidate = {
  status: 'pending', discovery_origin: 'web_research', discovery_measure: '140/70-17',
  make: app.make, model: app.model, variant: null, year_start: 2019, year_end: 2019,
  position: 'rear', source_url: app.source_url,
  notes: 'catalog-fitment-research-20260906-v1; M007:Traseiro:140/70R17; sem aprovação automática',
};

describe('histórico de pesquisa já coberto por referência em uso', () => {
  it('identifica cópia exata, sem aprovar produto nem alterar o registro', () => {
    expect(activeResearchReference(Object.freeze(candidate))).toMatchObject({
      application_id: app.application_id, scope: 'manufacturer_measure', product_fitment_confirmed: false,
    });
    expect(candidate.status).toBe('pending');
  });

  it.each(['rejected', 'promoted', 'approved'])('preserva decisão humana %s', status => {
    expect(activeResearchReference({ ...candidate, status })).toBeNull();
  });

  it.each([
    { discovery_origin: 'conversation' }, { notes: 'Pesquisa manual diferente' },
    { position: 'front' }, { model: 'CB 300F Twister' }, { variant: 'Outra versão' },
    { year_start: 2020 }, { year_end: 2026 }, { source_url: 'https://example.com' },
    { discovery_measure: '150/60-17' },
  ])('não esconde candidata divergente: %j', change => {
    expect(activeResearchReference({ ...candidate, ...change })).toBeNull();
  });
});
