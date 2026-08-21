import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NETWORK_MUNICIPALITIES,
  normalizeMunicipalityKey,
  resolveNetworkMunicipality,
} from '../../../src/network/municipality-catalog.js';
import {
  networkMunicipalitiesSchema,
  networkMunicipalitiesTextSchema,
} from '../../../src/network/municipality-schema.js';

describe('catálogo oficial de municípios da Rede', () => {
  it('contém os 92 municípios do RJ sem chaves duplicadas', () => {
    expect(NETWORK_MUNICIPALITIES).toHaveLength(92);
    expect(new Set(NETWORK_MUNICIPALITIES.map(normalizeMunicipalityKey)).size).toBe(92);
  });

  it('tolera caixa e acento na API, mas devolve o nome oficial', () => {
    expect(resolveNetworkMunicipality('  NITEROI ')?.name).toBe('Niterói');
    expect(networkMunicipalitiesSchema.parse(['sao goncalo', 'São Gonçalo'])).toEqual(['São Gonçalo']);
  });

  it('recusa cidade inventada e lista vazia', () => {
    expect(networkMunicipalitiesSchema.safeParse(['Niteróii']).success).toBe(false);
    expect(networkMunicipalitiesSchema.safeParse([]).success).toBe(false);
    expect(networkMunicipalitiesTextSchema.safeParse('Niterói, Cidade Inventada').success).toBe(false);
  });

  it('protege também a gravação direta em produção no banco', () => {
    const migration = readFileSync(
      resolve(process.cwd(), 'db/migrations/0195_network_municipality_catalog.sql'),
      'utf8',
    );
    expect(migration).toContain('unit_coverage_supported_municipality');
    expect(migration).toContain("IF NEW.environment='prod'");
    expect(migration).toContain("ERRCODE='23514'");
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('SET search_path=pg_catalog,network');
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION network.guard_supported_municipality() FROM PUBLIC',
    );
    for (const municipality of NETWORK_MUNICIPALITIES) {
      expect(migration).toContain(`('${normalizeMunicipalityKey(municipality)}'`);
    }
  });
});
