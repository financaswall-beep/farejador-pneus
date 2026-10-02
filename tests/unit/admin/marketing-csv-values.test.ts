import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

it('exporta negativos como números e protege apenas strings contra fórmulas', async () => {
  const window = { PAINEL_MODULES: {} as Record<string, () => any> };
  let output: Blob | undefined;
  const link = { click: vi.fn(), href: '', download: '' };
  runInNewContext(readFileSync('painel/public/app.marketing.google.js', 'utf8'), { window, Blob,
    URL: { createObjectURL: (blob: Blob) => { output = blob; return 'blob:test'; }, revokeObjectURL: vi.fn() },
    document: { createElement: () => link }, setTimeout: (fn: () => void) => fn() });
  const state = { ...window.PAINEL_MODULES.marketingGoogle(), marketingPeriod: '30d' };
  state.googleExportCells([['Valor', 'Título'], [-32.5, '=SUM(A1:A2)'], [2.75, '  -comando'], [0, 'Pneu "novo"']]);
  const text = await output!.text();
  expect(text).toContain('-32,5;"\' =SUM(A1:A2)"');
  expect(text).toContain('2,75;"\'   -comando"');
  expect(text).toContain('0;"Pneu ""novo"""');
  expect(link.click).toHaveBeenCalledOnce();
});
