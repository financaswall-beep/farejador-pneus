import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

type TimeApi = {
  dateKey: (value: string | Date) => string;
  formatDate: (value: string | Date) => string;
  formatDateTime: (value: string | Date) => string;
  weekBuckets: (now: Date, count: number) => Array<{
    startKey: string; endKey: string; label: string;
  }>;
  nextBoundary: (frequency: string, now: Date) => string;
};

function load(file: string): TimeApi {
  const sandbox = { window: {} as { FarejadorTime?: TimeApi }, Intl, Date, Object };
  vm.runInNewContext(readFileSync(file, 'utf8'), sandbox);
  if (!sandbox.window.FarejadorTime) throw new Error('FarejadorTime ausente');
  return sandbox.window.FarejadorTime;
}

describe('relógio único dos navegadores', () => {
  const matrixFile = 'painel/public/business-time.js';
  const partnerFile = 'parceiro/public/app.business-time.js';

  it('mantém o mesmo contrato na Matriz e no parceiro', () => {
    expect(readFileSync(matrixFile, 'utf8')).toBe(readFileSync(partnerFile, 'utf8'));
  });

  it.each([matrixFile, partnerFile])('não desloca DATE e exibe instantes em São Paulo: %s', (file) => {
    const time = load(file);
    expect(time.formatDate('2026-08-21')).toBe('21/08/2026');
    expect(time.dateKey('2026-08-22T01:30:00.000Z')).toBe('2026-08-21');
    expect(time.formatDateTime('2026-08-22T01:30:00.000Z')).toContain('21/08/2026');
  });

  it('cria semanas completas, contíguas e pelo calendário comercial', () => {
    const weeks = load(matrixFile).weekBuckets(new Date('2026-08-22T01:30:00.000Z'), 4);
    expect(weeks).toHaveLength(4);
    expect(weeks.at(-1)).toMatchObject({ startKey: '2026-08-15', endKey: '2026-08-21' });
    for (let index = 1; index < weeks.length; index += 1) {
      const previousEnd = new Date(`${weeks[index - 1].endKey}T12:00:00Z`);
      previousEnd.setUTCDate(previousEnd.getUTCDate()+1);
      expect(previousEnd.toISOString().slice(0, 10)).toBe(weeks[index].startKey);
    }
  });

  it('calcula virada semanal e mensal sem depender do fuso do aparelho', () => {
    const time = load(matrixFile);
    const fridayNight = new Date('2026-08-22T01:30:00.000Z');
    expect(time.nextBoundary('weekly', fridayNight)).toBe('2026-08-23');
    expect(time.nextBoundary('monthly', fridayNight)).toBe('2026-09-01');
  });
});
