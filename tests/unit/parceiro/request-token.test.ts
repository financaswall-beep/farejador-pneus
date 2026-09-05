import { describe, expect, it } from 'vitest';
import { bearerFrom } from '../../../src/parceiro/request-token';

describe('bearer cru das rotas do parceiro', () => {
  it.each([
    [{ authorization: 'Bearer  ps_fixture  ' }, 'ps_fixture'],
    [{ 'x-partner-token': '  legacy_fixture  ' }, 'legacy_fixture'],
    [{ authorization: 'Bearer ps_fixture', 'x-partner-token': 'legacy_fixture' }, 'ps_fixture'],
    [{ authorization: 'Basic fixture', 'x-partner-token': 'legacy_fixture' }, 'legacy_fixture'],
    [{ authorization: 'Bearer ', 'x-partner-token': 'legacy_fixture' }, ''],
    [{ authorization: ['Bearer fixture'], 'x-partner-token': ['fixture'] }, ''],
    [{}, ''],
  ])('preserva extração, prioridade e fallback: %j', (headers, expected) => {
    expect(bearerFrom({ headers })).toBe(expected);
  });
});
