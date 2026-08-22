import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('migration de integridade do Marketing', () => {
  const sql = readFileSync(
    resolve('db/migrations/0198_marketing_integrity.sql'),
    'utf8',
  );

  it('fecha sincronização abandonada e impede duas execuções concorrentes', () => {
    expect(sql).toContain("started_at<now()-interval '1 hour'");
    expect(sql).toContain('meta_sync_superseded');
    expect(sql).toContain('meta_sync_runs_lifecycle_check');
    expect(sql).toContain('meta_sync_runs_one_running_uniq');
    expect(sql).toContain("WHERE status='running'");
  });

  it('valida mensagem, conversa e janela causal sem dar acesso ao parceiro', () => {
    expect(sql).toContain('validate_ad_referral_causality');
    expect(sql).toContain('validate_order_attribution_causality');
    expect(sql).toContain("interval '7 days'");
    expect(sql).toContain('validate_meta_messaging_match');
    expect(sql).toContain("ARRAY['partner_app','farejador_partner_app']");
    expect(sql).not.toMatch(/access_token\s*=|EA[A-Za-z0-9]{20,}/i);
  });
});
