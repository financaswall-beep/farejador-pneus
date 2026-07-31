import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('migration de escopo financeiro das campanhas', () => {
  const sql = readFileSync(
    resolve('db/migrations/0159_marketing_campaign_scope.sql'),
    'utf8',
  );

  it('nasce pendente, separa gasto bruto do financeiro e preserva ambiente', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS marketing.campaign_scopes');
    expect(sql).toContain('environment           env_t NOT NULL');
    expect(sql).toContain("scope IN ('pending','matrix','external')");
    expect(sql).toContain('UNIQUE (environment, ad_account_id, campaign_id)');
    expect(sql).toContain('marketing.meta_insights_daily_scoped');
    expect(sql).toContain("CASE WHEN s.scope='matrix' THEN i.spend");
    expect(sql).toContain('ON CONFLICT (environment,ad_account_id,campaign_id)');
  });

  it('permite suprimir CAPI sem apagar evento e mantém o portal sem acesso', () => {
    expect(sql).toContain("'dead_letter','suppressed'");
    expect(sql).toContain('campaign_scope_id');
    expect(sql).toContain('suppression_reason');
    expect(sql).toContain("ARRAY['partner_app', 'farejador_partner_app']");
    expect(sql).toContain(
      "format('REVOKE ALL ON marketing.campaign_scopes FROM %I', restricted_role)",
    );
    expect(sql).not.toMatch(/EA[A-Za-z0-9]{20,}|access_token\s*=/i);
  });
});
