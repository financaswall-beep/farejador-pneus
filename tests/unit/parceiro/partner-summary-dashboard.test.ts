import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('resumo simples do parceiro', () => {
  it('mantém os totais oficiais na view e acrescenta apenas leituras operacionais', () => {
    const query = source('src/parceiro/partner-summary-dashboard.ts');
    expect(query).toContain('FROM network.partner_unit_summary');
    expect(query).toContain('movement_series');
    expect(query).toContain('recent_events');
    expect(query).toContain('withPartnerContext(ctx.partnerUnitId');
    expect(query).toMatch(/environment=\$1 AND unit_id=\$2/g);
    expect(query).not.toContain('/admin/api');
  });

  it('aceita somente os três períodos fechados pelo servidor', () => {
    const route = source('src/parceiro/route-partner-summary.ts');
    expect(route).toContain("z.enum(['today', '7d', 'month']).default('month')");
    expect(route).toContain("error: 'periodo_invalido'");
    expect(route).toContain('getPartnerResumo(getPartnerContext(request), parsed.data.period)');
  });
});
