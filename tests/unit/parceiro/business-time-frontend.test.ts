import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

describe('dia comercial no portal do parceiro', () => {
  it('usa agora para hoje, meio-dia de São Paulo para passado e recusa futuro', () => {
    const sandbox = { window: { PARCEIRO_MODULES: {} } };
    vm.runInNewContext(readFileSync('parceiro/public/app.format.js', 'utf8'), sandbox);
    const format = (sandbox.window.PARCEIRO_MODULES as Record<
      string, () => Record<string, unknown>
    >).format();
    const instant = format.businessFactInstant as (
      date: string, today: string, nowIso: string,
    ) => string;
    expect(instant.call(format, '2026-08-18', '2026-08-18', '2026-08-18T03:06:29.919Z'))
      .toBe('2026-08-18T03:06:29.919Z');
    expect(instant.call(format, '2026-08-17', '2026-08-18', '2026-08-18T03:06:29.919Z'))
      .toBe('2026-08-17T15:00:00.000Z');
    expect(() => instant.call(
      format, '2026-08-19', '2026-08-18', '2026-08-18T03:06:29.919Z',
    )).toThrow('business_date_future');
  });

  it('limita somente datas realizadas, não os vencimentos', () => {
    const html = readFileSync('parceiro/public/index.html', 'utf8');
    expect(html).toContain('x-model="payableForm.paid_at" :max="businessTodaySaoPaulo()"');
    expect(html).toContain('x-model="receivableForm.received_at" :max="businessTodaySaoPaulo()"');
    expect(html).toContain('x-model="payableForm.due_date"');
    expect(html).toContain('x-model="receivableForm.due_date"');
  });
});
