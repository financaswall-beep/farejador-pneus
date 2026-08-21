import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PartnerContext } from '../../../src/parceiro/auth.js';

const { partnerQuery, adminQuery } = vi.hoisted(() => ({
  partnerQuery: vi.fn(),
  adminQuery: vi.fn(),
}));
vi.mock('../../../src/parceiro/db.js', () => ({
  withPartnerContext: vi.fn(async (_partnerUnitId: string, callback: (client: { query: typeof partnerQuery }) => unknown) => callback({ query: partnerQuery })),
}));
vi.mock('../../../src/persistence/db.js', () => ({ pool: { query: adminQuery } }));
vi.mock('../../../src/parceiro/queries.js', () => ({
  settlePartnerPayable: vi.fn(),
}));

import { getPartnerSimpleFinance } from '../../../src/parceiro/simple-finance.js';
import { getPartnerOperationCommissions } from '../../../src/parceiro/operation-commissions.js';
import { operationCommissionBounds } from '../../../src/shared/operation-commissions.js';

const route = readFileSync(resolve('src/parceiro/route-simple-finance.ts'), 'utf8');
const routeRoot = readFileSync(resolve('src/parceiro/route.ts'), 'utf8');
const operationAuth = readFileSync(resolve('src/admin/caixa/operation-auth.ts'), 'utf8');

describe('Financeiro simples do proprietario parceiro', () => {
  it('calcula o saldo sem aceitar unidade ou papel enviados pelo navegador', async () => {
    partnerQuery.mockResolvedValueOnce({ rows: [{
      cash_in: '18450.00', cash_out: '5670.00',
      receivable_total: '2360.00', receivable_count: 5,
      due_today_total: '480.00', due_today_count: 1,
      commission_total: '1280.00',
    }] });
    adminQuery.mockResolvedValueOnce({ rows: [{ commission_collaborators: 4 }] });
    const context: PartnerContext = {
      environment: 'test', partnerId: 'partner-1', partnerUnitId: 'partner-unit-1',
      unitId: 'unit-1', slug: 'rio-do-ouro', partnerName: 'Rio',
      unitName: 'Borracharia Rio do Ouro', role: 'owner', tokenId: 'owner-token',
    };

    const payload = await getPartnerSimpleFinance(context, '7d');

    expect(payload).toMatchObject({
      cash_in: 18450, cash_out: 5670, cash_net: 12780,
      receivable_total: 2360, due_today_count: 1,
      commission_total: 1280, commission_collaborators: 4, range: '7d',
    });
    expect(partnerQuery.mock.calls[0]?.[1]).toEqual(['test', 'unit-1', 7]);
    expect(partnerQuery.mock.calls[0]?.[0]).toContain('range_start_at');
    expect(partnerQuery.mock.calls[0]?.[0]).toContain("po.delivery_status<>'delivered'");
    expect(partnerQuery.mock.calls[0]?.[0]).toContain('NOT po.awaiting_pickup');
    expect(partnerQuery.mock.calls[0]?.[0]).toContain('COALESCE(po.retrieved_at,po.created_at)');
    expect(partnerQuery.mock.calls[0]?.[0]).not.toContain('partner_access_tokens');
    expect(adminQuery.mock.calls[0]?.[1]).toEqual(['test', 'partner-unit-1']);
  });

  it('trava a API no owner e nao transforma permissao de funcionario em acesso financeiro', () => {
    expect(route).toContain("fastify.get('/parceiro/:slug/api/financeiro-simples'");
    expect(route).toContain("fastify.get('/parceiro/:slug/api/financeiro-entradas'");
    expect(route).toContain("fastify.get('/parceiro/:slug/api/financeiro-saidas'");
    expect(route).toContain("fastify.get('/parceiro/:slug/api/financeiro-comissoes'");
    expect(route).toContain("fastify.get('/parceiro/:slug/api/financeiro-comissoes/:collaboratorId'");
    expect(route).toContain("fastify.post('/parceiro/:slug/api/financeiro-comissoes/:collaboratorId/pagar'");
    expect(route).toContain('preHandler: [requirePartnerAuth, requireOwner]');
    expect(routeRoot).toContain('registerPartnerSimpleFinanceRoute(fastify)');
    expect(operationAuth).toContain("const canSeeFinance = row.role === 'owner'");
    expect(operationAuth).toContain('financeiro: canSeeFinance');
    expect(route).toContain("z.enum(['today', '7d', '15d', '30d'])");
  });

  it('mantem o periodo fechado mais antigo pagavel mesmo com fatos do periodo atual abertos', async () => {
    const context: PartnerContext = {
      environment: 'test', partnerId: 'partner-1', partnerUnitId: 'partner-unit-1',
      unitId: 'unit-1', slug: 'rio-do-ouro', partnerName: 'Rio',
      unitName: 'Borracharia Rio do Ouro', role: 'owner', tokenId: 'owner-token',
    };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('WITH facts AS')) return { rows: [{
        token_id: 'seller-1', label: 'Wallace', username: 'wallace', active: true,
        commission_kind: 'percent', commission_value: '5', sales_count: 1,
        gross_sales: '399.80', commission_amount: '19.99', unsettled_count: 1,
      }] };
      return { rows: [{
        token_id: 'seller-1', payable_id: 'payable-old', payable_amount: '19.99',
        payable_status: 'open', settlement_frequency: 'weekly',
        period_start: '2026-07-05', period_end: '2026-07-11',
      }] };
    });

    const payload = await getPartnerOperationCommissions(
      context, '30d', { query } as never,
    );
    const bounds = operationCommissionBounds('30d');

    expect(bounds.start).toBe(bounds.competence);
    expect(payload.collaborators[0]).toMatchObject({
      name: 'Wallace', commission_amount: 19.99, status: 'payable',
      payment_target_id: 'payable-old', payment_total: 19.99,
      payment_period_start: '2026-07-05', payment_period_end: '2026-07-11',
      settlement_frequency: 'weekly',
    });
  });

  it('libera a liquidacao somente depois que toda comissao entrou na folha fechada', async () => {
    const context: PartnerContext = {
      environment: 'test', partnerId: 'partner-1', partnerUnitId: 'partner-unit-1',
      unitId: 'unit-1', slug: 'rio-do-ouro', partnerName: 'Rio',
      unitName: 'Borracharia Rio do Ouro', role: 'owner', tokenId: 'owner-token',
    };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('WITH facts AS')) return { rows: [{
        token_id: 'seller-1', label: 'Wallace', username: 'wallace', active: true,
        commission_kind: 'percent', commission_value: '5', sales_count: 1,
        gross_sales: '399.80', commission_amount: '19.99', unsettled_count: 0,
      }] };
      return { rows: [{
        token_id: 'seller-1', payable_id: 'payable-1', payable_amount: '19.99',
        payable_status: 'open', settlement_frequency: 'monthly',
        period_start: '2026-08-01', period_end: '2026-08-31',
      }] };
    });

    const payload = await getPartnerOperationCommissions(
      context, '30d', { query } as never,
    );

    expect(payload.collaborators[0]).toMatchObject({
      status: 'payable', payment_target_id: 'payable-1', payment_total: 19.99,
    });
  });
});
