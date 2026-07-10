import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

describe('rede fallback HTML rendering', () => {
  it('escapes values received from the API before putting them in innerHTML', async () => {
    const source = await readFile(path.join(process.cwd(), 'painel', 'public', 'rede-fallback.js'), 'utf8');
    const body = { innerHTML: '' };
    let loadPromise: Promise<unknown> | undefined;
    const malicious = '<img src=x onerror=alert(1)>';
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        rows: [{
          display_name: malicious,
          slug: malicious,
          responsible_name: malicious,
          unit_status: malicious,
          top_items: [{ label: malicious, quantity: 1 }],
          stock_rows: [{ item_name: malicious, tire_size: malicious, quantity_on_hand: 1, is_tracked: true }],
          recent_events: [{ event_at: '2026-07-10T12:00:00Z', type: malicious, description: malicious, amount: 10 }],
        }],
      }),
    });

    runInNewContext(source, {
      window: { Alpine: false, addEventListener: (_event: string, callback: () => void) => callback() },
      document: { body },
      sessionStorage: { getItem: () => 'admin-token' },
      fetch,
      setTimeout: (callback: () => Promise<unknown>) => {
        loadPromise = callback();
      },
      console,
      Error,
    });
    await loadPromise;

    expect(fetch).toHaveBeenCalledOnce();
    expect(body.innerHTML).not.toContain(malicious);
    expect(body.innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});
