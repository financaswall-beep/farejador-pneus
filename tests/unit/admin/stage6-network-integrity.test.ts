import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  approveApplicationSchema, partnerTermsSchema, settleComissaoSchema,
} from '../../../src/admin/painel/route-schemas.js';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('Etapa 6 — candidatura atômica', () => {
  it('exige chave de idempotência na borda HTTP', () => {
    const base = { municipios: ['Niterói'] };
    expect(approveApplicationSchema.safeParse(base).success).toBe(false);
    expect(approveApplicationSchema.safeParse({ ...base, idempotency_key: 'approve-key-123' }).success).toBe(true);
  });

  it('trava a candidatura e cria tudo com o mesmo client/transação', () => {
    const source = read('src/admin/painel/queries-candidaturas.ts');
    expect(source).toContain('FOR UPDATE');
    expect(source).toContain('createPartnerUnitWithClient');
    expect(source).toContain("status='pending'");
    expect(source).toContain('beginIntegrityOperation');
    expect(source).toContain('completeIntegrityOperation');
    expect(source).toContain('partner_application_approved');
  });

  it('garante fisicamente uma unidade por candidatura', () => {
    const sql = read('db/migrations/0138_partner_application_atomicity.sql');
    expect(sql).toContain('source_application_id');
    expect(sql).toContain('partner_units_source_application_uniq');
    expect(sql).toContain('partner_applications_created_unit_fk');
  });

  it('não persiste token puro para replay e oferece reemissão separada auditada', () => {
    const source = read('src/admin/painel/queries-candidaturas.ts');
    expect(source).toContain("domain: 'partner.credential.reissue'");
    expect(source).toContain("eventType: 'partner_credential_reissued'");
    expect(source).toContain('credential_reissue_required: true');
    expect(source).toContain('network.hash_partner_token($3)');
  });
});

describe('Etapa 6 — comissão causal', () => {
  it('exige idempotência em liquidação e alteração dos termos', () => {
    expect(settleComissaoSchema.safeParse({ partner_id: crypto.randomUUID() }).success).toBe(false);
    expect(settleComissaoSchema.safeParse({ partner_id: crypto.randomUUID(),
      idempotency_key: 'settle-key-123', reason: 'recebido no painel' }).success).toBe(true);
    expect(partnerTermsSchema.safeParse({ commercial_model: 'commission',
      commission_percent: 5, monthly_fee: null }).success).toBe(false);
  });

  it('cria comissão na realização e preserva eventos imutáveis', () => {
    const sql = read('db/migrations/0139_partner_commission_causal_ledger.sql');
    expect(sql).toContain('partner_order_commission_transition');
    expect(sql).toContain('commission_entry_events');
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain('orders_partner_order_causal_uniq');
    expect(sql).toContain("event_type IN ('created','settled','reversed')");
    expect(sql).toContain('commission_entry_events_cause_fk');
    expect(sql).toContain('commission_entry_financial_fact_immutable');
    expect(sql).toContain('commission_entry_delete_immutable');
  });

  it('liquida e audita dentro da mesma operação repetível', () => {
    const source = read('src/admin/painel/queries-comissoes-acoes.ts');
    expect(source).toContain("domain: 'commission.settle'");
    expect(source).toContain('beginIntegrityOperation');
    expect(source).toContain('commission_entry_events');
    expect(source).toContain('completeIntegrityOperation');
    expect(source).not.toContain('Date.now()');
  });
});
