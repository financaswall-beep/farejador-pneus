import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve('db/migrations/0148_matriz_payroll_employment_and_assignment.sql'), 'utf8',
);
const management = readFileSync(
  resolve('src/admin/painel/queries-colaboradores-gestao.ts'), 'utf8',
);
const payroll = readFileSync(
  resolve('src/admin/painel/queries-colaboradores-folha.ts'), 'utf8',
);
const route = readFileSync(
  resolve('src/admin/painel/route-colaboradores-gestao.ts'), 'utf8',
);

describe('Folha — vigência e atribuição obrigatória', () => {
  it('define vigência pela competência, sem apagar desligados do mês', () => {
    expect(migration).toContain('matriz_collaborator_in_competence');
    expect(migration).toContain('p_revoked_at');
    expect(management).toContain('eligible_in_competence');
    expect(payroll).toContain('r.eligible_in_competence');
  });

  it('bloqueia fechamento com evento comissionável sem responsável', () => {
    expect(migration).toContain('matriz_payroll_assignment_gaps');
    expect(migration).toContain('o.seller_collaborator_id IS NULL');
    expect(migration).toContain('t.courier_collaborator_id IS NULL');
    expect(payroll).toContain('payroll_has_unassigned_events');
    expect(route).toContain('payroll_has_unassigned_events');
  });

  it('mantém as funções de folha fora do papel do parceiro', () => {
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION finance.matriz_payroll_assignment_gaps',
    );
    expect(migration).toContain('FROM farejador_partner_app');
  });
});
