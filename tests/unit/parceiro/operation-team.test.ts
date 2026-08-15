import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/persistence/db.js', () => ({ pool: { query: vi.fn() } }));

import {
  getPartnerOperationCommissionRule,
  getPartnerOperationCompensation,
  getPartnerOperationTeam,
} from '../../../src/parceiro/operation-team.js';
import type { PartnerContext } from '../../../src/parceiro/auth.js';

const context: PartnerContext = {
  environment: 'prod', partnerId: 'partner-1', partnerUnitId: 'unit-partner-1',
  unitId: 'unit-core-1', slug: 'rio-do-ouro', partnerName: 'Rio do Ouro',
  unitName: 'Borracharia Rio do Ouro', role: 'owner', tokenId: 'owner-1',
};

const member = {
  id: 'employee-1', name: 'Wallace', username: 'wallace', active: true,
  role_name: 'Vendedor', base_salary: '2300.00', salary_frequency: 'weekly' as const, payment_day: 5,
  starts_on: '2026-08-01',
  benefits: [{ name: 'Vale-transporte', amount: 220, active: true }],
  commission_kind: 'percent' as const, commission_value: '5.00',
  commission_active: true, commission_starts_on: '2026-08-01',
  commission_amount: '399.50',
};

describe('equipe da Operação do parceiro', () => {
  it('isola a listagem por ambiente e unidade e calcula os totais da tela', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [member] });
    const db = { query } as unknown as Pool;

    const result = await getPartnerOperationTeam(context, db);

    expect(query).toHaveBeenCalledWith(expect.stringContaining('pat.partner_unit_id=$2'), ['prod', 'unit-partner-1']);
    expect(result).toMatchObject({
      unit_name: 'Borracharia Rio do Ouro', active_count: 1,
      commission_total: 399.5,
    });
    expect(result.members[0]).toMatchObject({
      id: 'employee-1', work_area: 'sales', base_salary: 2300,
      benefits_total: 220, commission_value: 5,
    });
  });

  it('monta a remuneração sem expor nem buscar colaborador de outra loja', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [member] })
      .mockResolvedValueOnce({ rows: [{ employment_type: 'clt', payment_method: 'pix', salary_frequency: 'weekly' }] });
    const db = { query } as unknown as Pool;

    const result = await getPartnerOperationCompensation(context, 'employee-1', db);

    expect(query.mock.calls[1]?.[1]).toEqual(['prod', 'unit-partner-1', 'employee-1']);
    expect(result).toMatchObject({
      employment_type: 'clt', payment_method: 'pix', base_salary: 2300, salary_frequency: 'weekly',
      benefits_total: 220, fixed_total: 2520,
    });
  });

  it('entrega o histórico da comissão da mesma unidade', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [member] })
      .mockResolvedValueOnce({ rows: [{
        kind: 'percent', value: '5.00', active: true, starts_on: '2026-08-01', itemized: true,
        item_rules: {
          tire: { kind: 'fixed', value: 10 }, service: { kind: 'percent', value: 5 },
          other: { kind: 'none', value: 0 },
        },
      }] })
      .mockResolvedValueOnce({ rows: [{ itemized: true, item_rules: {
        tire: { kind: 'fixed', value: 10 }, service: { kind: 'percent', value: 5 },
        other: { kind: 'none', value: 0 },
      } }] });
    const db = { query } as unknown as Pool;

    const result = await getPartnerOperationCommissionRule(context, 'employee-1', db);

    expect(query.mock.calls[1]?.[1]).toEqual(['prod', 'unit-partner-1', 'employee-1']);
    expect(result?.history).toEqual([{
      kind: 'percent', basis: 'revenue', value: 5, active: true, starts_on: '2026-08-01', itemized: true,
      item_rules: {
        tire: { kind: 'fixed', value: 10 }, service: { kind: 'percent', value: 5 },
        other: { kind: 'none', value: 0 },
      },
    }]);
    expect(result).toMatchObject({ itemized: true, item_rules: {
      tire: { kind: 'fixed', value: 10 }, service: { kind: 'percent', value: 5 },
      other: { kind: 'none', value: 0 },
    } });
  });
});
