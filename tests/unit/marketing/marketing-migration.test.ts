import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('migration do pipeline de Marketing', () => {
  const sql = readFileSync(
    resolve('db/migrations/0144_marketing_attribution_pipeline.sql'),
    'utf8',
  );

  it('separa ambiente, mantém ledger e usa outbox durável', () => {
    for (const table of [
      'meta_sync_runs',
      'meta_insights_daily',
      'ad_referrals',
      'order_attributions',
      'capi_outbox',
    ]) {
      const start = sql.indexOf(`CREATE TABLE IF NOT EXISTS marketing.${table}`);
      const end = sql.indexOf(');', start);
      expect(sql.slice(start, end)).toContain('environment');
    }
    expect(sql).toContain('order_attributions_active_order_uniq');
    expect(sql).toContain('order_attributions_active_referral_uniq');
    expect(sql).toContain("status IN ('pending','processing','sent','failed','dead_letter')");
    expect(sql).toContain('superseded_by');
    expect(sql).toContain('not_before');
    expect(sql).toContain('locked_at');
  });

  it('não concede acesso ao parceiro e não contém segredo', () => {
    expect(sql).toContain('REVOKE ALL ON SCHEMA marketing FROM PUBLIC');
    expect(sql).toContain('REVOKE ALL ON SCHEMA marketing FROM partner_app');
    expect(sql).not.toMatch(/GRANT\s+.*partner_app/i);
    expect(sql).not.toMatch(/EA[A-Za-z0-9]{20,}|access_token\s*=/i);
  });
});
