import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

async function partnerFile(name: string): Promise<string> {
  return readFile(path.join(process.cwd(), 'parceiro', 'public', name), 'utf8');
}

describe('partner global navigation shell', () => {
  it('uses one topbar structure for every section', async () => {
    const html = await partnerFile('index.html');
    const topbar = html.split('<header class="pos-topbar">')[1]?.split('</header>')[0] ?? '';

    expect(topbar).toContain('class="pos-topbar-leading"');
    expect(topbar).toContain('class="pos-global-search"');
    expect(topbar).toContain('class="pos-topbar-actions"');
    expect(topbar.indexOf('pos-topbar-leading')).toBeLessThan(topbar.indexOf('pos-global-search'));
    expect(topbar.indexOf('pos-global-search')).toBeLessThan(topbar.indexOf('pos-topbar-actions'));
  });

  it('keeps sidebar width and centered search independent from the active tab', async () => {
    const css = await partnerFile('style.css');

    expect(css).toContain('CASCO GLOBAL 2026-08-06');
    expect(css).toContain('.pos-shell.checkout-screen { grid-template-columns: 248px minmax(0, 1fr); }');
    expect(css).toContain('.pos-shell.sidebar-collapsed { grid-template-columns: 64px minmax(0, 1fr); }');
    expect(css).toContain('grid-template-columns: minmax(160px, 1fr) minmax(280px, 520px) minmax(160px, 1fr);');
    expect(css).toContain('.pos-shell.checkout-screen .pos-topbar');
    expect(css).toContain('.pos-shell.checkout-screen[data-theme="light"] .pos-tire-mark { display: inline-block; }');
  });

  it('keeps the same green topbar and mobile navigation treatment', async () => {
    const css = await partnerFile('style.css');

    expect(css).toContain('Marca esmeralda do tema claro');
    expect(css).toContain('.pos-shell[data-theme="light"] .pos-sidebar');
    expect(css).toContain('background: linear-gradient(145deg, #064e3b 0%, #065f46 58%, #064e3b 100%);');
    expect(css).toContain('@media (max-width: 768px)');
    expect(css).toContain('.pos-shell .pos-mobile-brand');
    expect(css).toContain('.pos-shell[data-theme="light"] .pos-sidebar');
  });

  it('does not apply the emerald palette to the dark theme', async () => {
    const css = await partnerFile('style.css');

    expect(css).toContain('background: linear-gradient(180deg, rgba(18, 24, 29, .96), rgba(11, 15, 18, .98));');
    expect(css).toContain('background: linear-gradient(180deg, #ffe100, #ffc400);');
    expect(css).not.toContain('Marca esmeralda global: vale para claro e escuro');
    expect(css).not.toMatch(/\.pos-shell \.pos-sidebar,\s*\.pos-shell \.pos-topbar,\s*\.pos-shell\[data-theme="light"\]/);
  });
});
