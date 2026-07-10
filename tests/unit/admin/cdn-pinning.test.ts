import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('browser dependency pinning', () => {
  it.each([
    ['painel', 'public', 'index.html'],
    ['painel', 'public', 'entregas.html'],
    ['parceiro', 'public', 'index.html'],
  ])('does not use floating Alpine, Lucide or Chart.js versions in %s/%s/%s', async (...parts) => {
    const html = await readFile(path.join(process.cwd(), ...parts), 'utf8');

    expect(html).not.toContain('@latest');
    expect(html).not.toContain('@3.x.x');
    expect(html).not.toMatch(/npm\/chart\.js(?:["'])/);
  });
});
