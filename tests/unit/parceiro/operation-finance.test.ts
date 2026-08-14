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

import { getPartnerSimpleFinance } from '../../../src/parceiro/simple-finance.js';

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
    expect(partnerQuery.mock.calls[0]?.[0]).not.toContain('partner_access_tokens');
    expect(adminQuery.mock.calls[0]?.[1]).toEqual(['test', 'partner-unit-1']);
  });

  it('trava a API no owner e nao transforma permissao de funcionario em acesso financeiro', () => {
    expect(route).toContain("fastify.get('/parceiro/:slug/api/financeiro-simples'");
    expect(route).toContain("fastify.get('/parceiro/:slug/api/financeiro-entradas'");
    expect(route).toContain("fastify.get('/parceiro/:slug/api/financeiro-saidas'");
    expect(route).toContain('preHandler: [requirePartnerAuth, requireOwner]');
    expect(routeRoot).toContain('registerPartnerSimpleFinanceRoute(fastify)');
    expect(operationAuth).toContain("const canSeeFinance = row.role === 'owner'");
    expect(operationAuth).toContain('financeiro: canSeeFinance');
    expect(route).toContain("z.enum(['today', '7d', '15d', '30d'])");
  });
});
