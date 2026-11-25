import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Movement = { created_at: string; qty_delta: number; source: 'entrada' };
type MovementView = {
  movTrend(): Array<{ key: string; total: number }>;
  movResumo(): { entradas: number; saidas: number; saldo: number };
  movGroups(): Array<{ key: string; label: string; rows: Movement[] }>;
  movHora(row: Movement): string;
};

function loadMovements(rows: Movement[]): MovementView {
  const html = readFileSync('painel/public/index.html', 'utf8');
  const component = html.match(/id="galpao-filme"\s+x-data="([^"]+)"/)?.[1];
  if (!component) throw new Error('Componente de movimentações do galpão não encontrado');

  const context = createContext({
    Date,
    window: {},
    galpaoFilme: { rows },
    movRotulo: () => 'Entrada avulsa',
  });
  const clock = readFileSync('painel/public/business-time.js', 'utf8');
  runInContext(clock, context, { filename: 'business-time.js' });
  return runInContext(`(${component})`, context, { filename: 'galpao-filme' });
}

function entry(created_at: string, qty_delta: number): Movement {
  return { created_at, qty_delta, source: 'entrada' };
}

describe('Movimentações do galpão no horário de Brasília', () => {
  afterEach(() => vi.useRealTimers());

  it('inclui os 20 pneus no gráfico de 24/11 quando em UTC já é dia 25', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-25T00:59:00Z'));
    const movements = loadMovements([
      entry('2026-11-25T00:53:02Z', 3),
      entry('2026-11-25T00:52:59Z', 13),
      entry('2026-11-25T00:52:55Z', 1),
      entry('2026-11-25T00:52:53Z', 2),
      entry('2026-11-25T00:52:48Z', 1),
    ]);

    expect(movements.movResumo()).toEqual({ entradas: 20, saidas: 0, saldo: 20 });
    expect(movements.movTrend().at(-1)).toMatchObject({ key: '2026-11-24', total: 20 });
  });

  it('mantém o mesmo grupo na virada UTC e troca de dia à meia-noite de Brasília', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-25T02:59:59Z'));
    const evening = entry('2026-11-25T00:52:48Z', 2);
    const beforeUtcMidnight = entry('2026-11-24T23:59:00Z', 1);
    const rows = [evening, beforeUtcMidnight];
    const movements = loadMovements(rows);

    expect(movements.movGroups()).toEqual([
      { key: '2026-11-24', label: expect.stringMatching(/^Hoje, 24\b/), rows: [evening, beforeUtcMidnight] },
    ]);
    expect(movements.movHora(evening)).toBe('21:52');

    vi.setSystemTime(new Date('2026-11-25T03:00:00Z'));
    const midnight = entry('2026-11-25T03:00:00Z', 4);
    rows.unshift(midnight);

    expect(movements.movGroups()).toEqual([
      { key: '2026-11-25', label: expect.stringMatching(/^Hoje, 25\b/), rows: [midnight] },
      { key: '2026-11-24', label: expect.stringMatching(/^Ontem, 24\b/), rows: [evening, beforeUtcMidnight] },
    ]);
    expect(movements.movTrend().slice(-2)).toMatchObject([
      { key: '2026-11-24', total: 3 },
      { key: '2026-11-25', total: 4 },
    ]);
  });
});
