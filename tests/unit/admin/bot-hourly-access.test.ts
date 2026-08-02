import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

function loadBotModule(): Record<string, any> {
  const sandbox = {
    window: { PAINEL_MODULES: {} as Record<string, () => Record<string, any>> },
  };
  const source = readFileSync(path.join(process.cwd(), 'painel', 'public', 'app.bot.js'), 'utf8');
  vm.runInNewContext(source, sandbox, { filename: 'app.bot.js' });
  return sandbox.window.PAINEL_MODULES.bot();
}

describe('Bot — acessos por horário', () => {
  it('normaliza a série em 24 horas e identifica o pico', () => {
    const bot = loadBotModule();
    bot.botVisao = {
      horarios: [
        { hora: 0, conversas: 2 },
        { hora: 18, conversas: 9 },
        { hora: 20, conversas: 4 },
      ],
    };

    expect(bot.botHorarios).toHaveLength(24);
    expect(bot.botHorarios[0]).toMatchObject({ hora: 0, label: '00h', n: 2 });
    expect(bot.botHorarios[1]).toMatchObject({ hora: 1, label: '01h', n: 0 });
    expect(bot.botHorarios[18]).toMatchObject({ n: 9, pct: 100, pico: true });
    expect(bot.botHorarioMax).toBe(9);
    expect(bot.botHorarioPico).toBe('18h');
  });

  it('mantém a definição e os elementos acessíveis do gráfico no HTML', () => {
    const html = readFileSync(path.join(process.cwd(), 'painel', 'public', 'index.html'), 'utf8');

    expect(html).toContain('Acessos por horário');
    expect(html).toContain('Conversas iniciadas em cada hora');
    expect(html).toContain('aria-label="Gráfico de conversas iniciadas por hora"');
    expect(html).toContain('app.bot.js?v=20260802-horarios1');
  });
});
