import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadMovementModule(): Record<string, any> {
  const sandbox = {
    window: { PAINEL_MODULES: {} as Record<string, () => Record<string, any>> },
    URLSearchParams,
    Intl,
  };
  const timeSource = readFileSync(path.join(process.cwd(), 'painel', 'public', 'business-time.js'), 'utf8');
  const source = readFileSync(path.join(process.cwd(), 'painel', 'public', 'app.bot.movimento.js'), 'utf8');
  vm.runInNewContext(timeSource, sandbox, { filename: 'business-time.js' });
  vm.runInNewContext(source, sandbox, { filename: 'app.bot.movimento.js' });
  return sandbox.window.PAINEL_MODULES.botMovimento();
}

describe('Bot — movimento diário e semanal', () => {
  it('monta domingo a sábado e impede avançar além da semana atual', () => {
    const movement = loadMovementModule();
    movement.botMovementDate = '2026-08-21';
    movement.botMovement = { range: { today: '2026-08-22' } };

    expect(movement.botMovementWeekDays.map((day: any) => day.date)).toEqual([
      '2026-08-16', '2026-08-17', '2026-08-18', '2026-08-19',
      '2026-08-20', '2026-08-21', '2026-08-22',
    ]);
    expect(movement.botMovementWeekDays[5]).toMatchObject({ label: 'Sex', day: 21, selected: true });
    expect(movement.botMovementWeekLabel).toBe('16 a 22 de agosto');
    expect(movement.botMovementCanNextWeek).toBe(false);
  });

  it('clicar no dia troca todo o recorte para o diário', () => {
    const movement = loadMovementModule();
    movement.botMovementMode = 'weekly';
    movement.botMovement = { range: { today: '2026-08-22' } };
    movement.loadBotMovement = vi.fn();

    movement.selectBotMovementDay('2026-08-21');

    expect(movement.botMovementMode).toBe('daily');
    expect(movement.botMovementDate).toBe('2026-08-21');
    expect(movement.loadBotMovement).toHaveBeenCalledOnce();
  });

  it('normaliza as 24 horas e deriva o pico do mesmo payload', () => {
    const movement = loadMovementModule();
    movement.botMovement = { horarios: [{ hora: 10, conversas: 6 }, { hora: 18, conversas: 2 }] };

    expect(movement.botMovementHorarios).toHaveLength(24);
    expect(movement.botMovementHorarios[10]).toMatchObject({ label: '10h', n: 6, pct: 100, peak: true });
    expect(movement.botMovementHorarios[11]).toMatchObject({ n: 0, pct: 0, peak: false });
    expect(movement.botMovementPeak).toBe('10h');
  });
});
