import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

async function partnerFile(name: string): Promise<string> {
  return readFile(path.join(process.cwd(), 'parceiro', 'public', name), 'utf8');
}

function relativeLuminance(hex: string): number {
  const channels = hex.match(/[\da-f]{2}/gi)?.map((value) => Number.parseInt(value, 16) / 255) ?? [];
  const linear = channels.map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
}

function contrast(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

describe('partner light theme Matriz palette', () => {
  it('uses the neutral gray scale and emerald accent from Matriz', async () => {
    const [html, css, charts] = await Promise.all([
      partnerFile('index.html'),
      partnerFile('style.css'),
      partnerFile('app.charts.pdv.js'),
    ]);

    expect(html).toContain('style.css?v=20260811-recebimento1');
    expect(css).toContain('AUDITORIA VISUAL 2026-08-06 — TEMA CLARO ALINHADO À MATRIZ');
    expect(css).toContain('--matrix-canvas: #f9fafb');
    expect(css).toContain('--matrix-surface: #ffffff');
    expect(css).toContain('--matrix-border: #e5e7eb');
    expect(css).toContain('--matrix-text: #111827');
    expect(css).toContain('--matrix-text-body: #374151');
    expect(css).toContain('--matrix-text-muted: #6b7280');
    expect(css).toContain('background: var(--matrix-canvas) !important');
    expect(charts).toContain("backgroundColor: light ? '#111827'");
    expect(charts).toContain("ticks: { color: light ? '#6b7280'");
  });

  it('keeps normal-sized text at WCAG AA contrast on white surfaces', () => {
    expect(contrast('#111827', '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#374151', '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#6b7280', '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#047857', '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the dark theme base palette unchanged', async () => {
    const css = await partnerFile('style.css');

    expect(css).toContain('--pos-bg: #0b0f12');
    expect(css).toContain('--pos-yellow: #ffd000');
    expect(css).toContain('linear-gradient(135deg, #11161b 0%, #0b0f12 48%, #080b0e 100%)');
  });
});
