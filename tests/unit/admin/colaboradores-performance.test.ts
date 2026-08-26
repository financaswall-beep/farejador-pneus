import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/parceiro/db.js', () => ({ withPartnerContext: vi.fn() }));

import { getPartnerTeamPerformance } from '../../../src/parceiro/operation-team-performance.js';

function performanceModule() {
  const file = 'painel/public/app.colaboradores.performance.js';
  const sandbox: any = {
    window: { PAINEL_MODULES: {} }, Date, Intl, Set, Map, Math, Number, String, Object,
    encodeURIComponent,
  };
  vm.runInNewContext(readFileSync(resolve(file), 'utf8'), sandbox, { filename: file });
  return sandbox.window.PAINEL_MODULES.colaboradoresPerformance();
}

describe('desempenho operacional comum à Matriz e ao parceiro', () => {
  it('publica a mesma tela nos dois escopos e preserva a Folha da Matriz', () => {
    const html = readFileSync(resolve('painel/public/index.html'), 'utf8');
    expect(html).toContain("partnerColaboradoresSetTab('desempenho')");
    expect(html).toContain("colabTab === 'desempenho'");
    expect(html.split('Evolução da equipe')).toHaveLength(3);
    expect(html.split('Equipe comercial')).toHaveLength(3);
    expect(html.split('Equipe operacional')).toHaveLength(3);
    expect(html).toContain("colabTab === 'folha'");
    expect(html).toContain('Ao fechar, os títulos entram automaticamente no Financeiro');
  });

  it('filtra funções e recalcula cards sem misturar resultados de outro colaborador', () => {
    const app: any = { formatCurrency: (value: number) => String(value) };
    Object.defineProperties(app, Object.getOwnPropertyDescriptors(performanceModule()));
    app.teamPerformance.payload = {
      period_start: '2026-08-01', period_end: '2026-08-03', unit_name: 'Canário',
      summary: { unassigned_sales: 1, waiting_pickups: 2, commission_review_count: 3 },
      collaborators: [
        { id: 'v1', name: 'Vendedor', work_area: 'sales', sales_count: 2, revenue: 200,
          margin: 80, installations_count: 0, deliveries_count: 0, commission_amount: 10,
          missing_cost_items: 0 },
        { id: 'o1', name: 'Oficina', work_area: 'workshop', sales_count: 0, revenue: 0,
          margin: 0, installations_count: 4, deliveries_count: 0, commission_amount: 0,
          missing_cost_items: 0 },
      ],
      daily: [
        { date: '2026-08-01', collaborator_id: 'v1', sales_count: 2, installations_count: 0 },
        { date: '2026-08-01', collaborator_id: 'o1', sales_count: 0, installations_count: 4 },
      ],
    };
    app.teamPerformance.workArea = 'sales';
    expect(app.teamPerformanceSummary()).toMatchObject({
      sales_count: 2, revenue: 200, margin: 80, installations_count: 0,
      unassigned_sales: 1, waiting_pickups: 2,
    });
    expect(app.teamPerformanceDays()[0]).toMatchObject({ sales_count: 2, installations_count: 0 });
  });

  it('escopa todas as consultas do parceiro por ambiente, unidade e cadastro parceiro', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        id: 'v1', name: 'Ana', role: 'Vendedor', work_area: 'sales', active: true,
        sales_count: 2, revenue: '180', margin: '70', installations_count: 0,
        pickups_count: 0, deliveries_count: 0, average_service_minutes: null,
        commission_amount: '9', missing_cost_items: 0,
      }] })
      .mockResolvedValueOnce({ rows: [{
        date: '2026-08-26', collaborator_id: 'v1', sales_count: 2, installations_count: 0,
      }] })
      .mockResolvedValueOnce({ rows: [{
        unassigned_sales: 0, waiting_pickups: 1, commission_review_count: 1,
      }] });
    const payload = await getPartnerTeamPerformance({
      environment: 'test', partnerId: 'partner-1', partnerUnitId: 'partner-unit-1',
      unitId: 'unit-1', slug: 'canario', partnerName: 'Canário', unitName: 'Unidade Canário',
      role: 'owner', tokenId: 'owner-1',
    }, '7d', { query } as any);

    expect(query).toHaveBeenCalledTimes(3);
    for (const call of query.mock.calls) {
      expect(call[1][0]).toBe('test');
      expect(call[1][1]).toBe('unit-1');
      expect(call[1]).toHaveLength(4);
    }
    expect(String(query.mock.calls[0][0])).toContain('network.partner_staff_directory()');
    expect(String(query.mock.calls[0][0])).not.toContain('network.partner_access_tokens');
    expect(payload.summary).toMatchObject({ sales_count: 2, revenue: 180, margin: 70 });
    expect(payload.unit_name).toBe('Unidade Canário');
  });
});
