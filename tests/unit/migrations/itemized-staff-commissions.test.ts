import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve('db/migrations/0173_itemized_staff_commissions.sql'),
  'utf8',
);

describe('migration 0173 — comissão por tipo de item', () => {
  it('permite fixo somente por unidade de pneu', () => {
    expect(migration).toContain("v_kind='fixed' AND v_group<>'tire'");
    expect(migration).toContain("v_kind='fixed' AND p_group='tire'");
    expect(migration).toContain('p_quantity,');
  });

  it('calcula Matriz e parceiro pela classificação congelada do item', () => {
    expect(migration).toContain('finance.matriz_retail_itemized_commission');
    expect(migration).toContain('finance.matriz_wholesale_itemized_commission');
    expect(migration).toContain('finance.partner_itemized_commission');
    expect(migration).toContain("WHEN 'servico' THEN 'service'");
    expect(migration).toContain("WHEN 'service' THEN 'service'");
  });

  it('congela regra do parceiro e usa snapshot da folha no estorno da Matriz', () => {
    expect(migration).toContain('NEW.commission_rules := v_rule.item_rules');
    expect(migration).toContain("item.calculation #> '{rule,item_rules}'");
    expect(migration).toContain('NEW.commission_itemized,NEW.commission_rules');
    expect(migration).toContain('partner_staff_commission_fact_immutable');
  });
});
