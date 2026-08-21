import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPartnerSchema, partnerTermsSchema } from '../../../src/admin/painel/route-schemas.js';

const read = (file: string): string => readFileSync(resolve(process.cwd(), file), 'utf8');

describe('auditoria da Rede — correções de segurança e consistência', () => {
  it('deixa criação, aprovação, recusa e reemissão somente para o dono', () => {
    const partnerRoutes = read('src/admin/painel/route-parceiros.ts');
    const applicationRoutes = read('src/admin/painel/route-candidaturas.ts');
    expect(partnerRoutes).toMatch(/post\('\/admin\/api\/partners',[\s\S]*?requireAdminOwner/);
    expect(applicationRoutes).toMatch(/partner-applications\/:id\/approve'[\s\S]{0,100}requireAdminOwner/);
    expect(applicationRoutes).toMatch(/partner-applications\/:id\/reject'[\s\S]{0,100}requireAdminOwner/);
    expect(applicationRoutes).toMatch(/partner-units\/:id\/reissue-token'[\s\S]{0,100}requireAdminOwner/);
  });

  it('exige termos comerciais completos e chave idempotente', () => {
    const base = { idempotency_key: 'partner-create-123',trade_name: 'Loja',
      municipios: ['Niterói'] };
    expect(createPartnerSchema.safeParse(base).success).toBe(false);
    expect(createPartnerSchema.safeParse({ ...base,commission_percent: 0 }).success).toBe(true);
    expect(partnerTermsSchema.safeParse({ idempotency_key: 'terms-key-123',
      commercial_model: 'monthly',commission_percent: null,monthly_fee: 0 }).success).toBe(true);
    expect(partnerTermsSchema.safeParse({ idempotency_key: 'terms-key-123',
      commercial_model: 'monthly',commission_percent: 5,monthly_fee: 10 }).success).toBe(false);
  });

  it('consome a chave bruta sem revogar conta e sessões', () => {
    const migration = read('db/migrations/0194_network_audit_corrections.sql');
    const credential = read('src/parceiro/queries.ts');
    const reissue = read('src/admin/painel/queries-candidaturas.ts');
    expect(migration).toContain('raw_access_consumed_at');
    expect(migration).toContain('partner_raw_access_consumption_immutable');
    expect(credential).toContain('raw_access_consumed_at=COALESCE(raw_access_consumed_at,now())');
    expect(reissue).not.toContain('SET revoked_at=now()');
  });

  it('mantém GETs financeiros sem escrita e move reconciliação para o scheduler', () => {
    const routes = read('src/admin/painel/route-atacado.ts') + read('src/admin/painel/route-financeiro.ts');
    const scheduler = read('src/monthly-continuity.ts');
    expect(routes).not.toContain('await sweepCommissionEntries()');
    expect(scheduler).toContain('await sweepCommissionEntries(env.FAREJADOR_ENV)');
  });

  it('usa despesas contábeis completas, mensalidade real e dia de São Paulo', () => {
    const query = read('src/admin/painel/queries-rede.ts')
      + read('src/admin/painel/queries-rede-accounting-sql.ts');
    const ui = read('painel/public/app.rede.apply.js');
    expect(query).toContain('pe.source_payable_id IS NULL');
    expect(query).toContain('pp.source_purchase_id IS NULL');
    expect(query).toContain('partner_staff_commission_entries');
    expect(query).toContain('monthly_fee_open_total');
    expect(query).toContain("day_ref.day AT TIME ZONE '${PAINEL_TZ}'");
    expect(ui).toContain('row.monthly_fee_open_total');
  });

  it('faz o funil ler decisões causais e expõe atendimentos não atribuídos', () => {
    const query = read('src/admin/painel/queries-rede-resumo.ts');
    const routing = read('src/atendente-v2/tools.ts');
    const html = read('painel/public/index.html');
    expect(query).toContain('ops.partner_routing_decisions');
    expect(routing).toContain('recordPartnerRoutingDecision');
    expect(html).toContain('redeFunnelUnassigned');
  });
});
