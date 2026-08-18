import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { normalizeSameDayFutureInstant } from '../../../src/admin/painel/wholesale-business-time.js';

describe('horário automático da venda de atacado', () => {
  it('troca meio-dia futuro de hoje pelo instante atual', () => {
    const now = new Date('2026-08-18T03:06:29.919Z');
    expect(normalizeSameDayFutureInstant('2026-08-18T15:00:00.000Z', now))
      .toBe(now.toISOString());
  });

  it('recusa dia futuro e não altera dia passado', () => {
    const now = new Date('2026-08-18T03:06:29.919Z');
    expect(() => normalizeSameDayFutureInstant('2026-08-19T15:00:00.000Z', now))
      .toThrow('business_date_future');
    expect(normalizeSameDayFutureInstant('2026-08-17T15:00:00.000Z', now))
      .toBe('2026-08-17T15:00:00.000Z');
  });

  it('a tela usa agora para hoje e meio-dia somente para datas anteriores', () => {
    const sandbox = { window: { PAINEL_MODULES: {} } };
    vm.runInNewContext(
      readFileSync(resolve('painel/public/app.format.js'), 'utf8'),
      sandbox,
    );
    vm.runInNewContext(
      readFileSync(resolve('painel/public/app.atacado.transfer.js'), 'utf8'),
      sandbox,
    );
    const modules = sandbox.window.PAINEL_MODULES as Record<string, () => Record<string, unknown>>;
    const module = { ...modules.format(), ...modules.atacadoTransfer() };
    const instant = module.atacadoBusinessInstant as (
      date: string, today: string, nowIso: string,
    ) => string;
    expect(instant.call(module, '2026-08-18', '2026-08-18', '2026-08-18T03:06:29.919Z'))
      .toBe('2026-08-18T03:06:29.919Z');
    expect(instant.call(module, '2026-08-17', '2026-08-18', '2026-08-18T03:06:29.919Z'))
      .toBe('2026-08-17T15:00:00.000Z');
    expect(() => instant.call(
      module, '2026-08-19', '2026-08-18', '2026-08-18T03:06:29.919Z',
    )).toThrow('business_date_future');
  });
});

describe('migration 0185', () => {
  it('compara o dia comercial de São Paulo, não o relógio', () => {
    const sql = readFileSync(
      resolve('db/migrations/0185_partner_purchase_business_date.sql'),
      'utf8',
    );
    expect(sql).toContain("(NEW.purchased_at AT TIME ZONE 'America/Sao_Paulo')::date");
    expect(sql).toContain("(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date");
    expect(sql).not.toContain("clock_timestamp()+interval '5 minutes'");
  });
});
