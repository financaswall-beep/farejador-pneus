import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

function loadModule() {
  const sandbox = {
    window: { PAINEL_MODULES: {} as Record<string, () => unknown> },
    Intl,
    Date,
    Object,
  };
  vm.runInNewContext(readFileSync('painel/public/business-time.js', 'utf8'), sandbox);
  vm.runInNewContext(readFileSync('painel/public/app.compras.acoes.js', 'utf8'), sandbox);
  return sandbox.window.PAINEL_MODULES.comprasAcoes() as {
    financeDate: (value: string) => string;
  };
}

describe('datas financeiras de Compras', () => {
  it('não desloca um DATE serializado pelo servidor como meia-noite UTC', () => {
    const module = loadModule();
    expect(module.financeDate('2026-09-30T00:00:00.000Z')).toBe('30/09/2026');
    expect(module.financeDate('2026-09-30')).toBe('30/09/2026');
  });

  it('mantém instantes reais no fuso comercial de São Paulo', () => {
    const module = loadModule();
    expect(module.financeDate('2026-08-22T01:30:00.000Z')).toBe('21/08/2026');
  });
});
