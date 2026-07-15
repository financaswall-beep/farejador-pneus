import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

async function loadQuery() {
  vi.resetModules();
  Object.assign(process.env, {
    NODE_ENV: 'test',
    FAREJADOR_ENV: 'test',
    DATABASE_URL: 'postgresql://postgres:password@example.test:6543/postgres',
    CHATWOOT_HMAC_SECRET: 'test-secret',
    ADMIN_AUTH_TOKEN: 'test-admin-token',
  });
  return (await import('../../../src/admin/painel/queries-clientes.js')).getClientesPainel;
}

describe('painel de clientes', () => {
  it('consolida as fontes existentes sem criar uma nova ficha de cliente', async () => {
    const getClientesPainel = await loadQuery();
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'chatwoot:1', source: 'chatwoot' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'balcao:1', source: 'balcao' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'parceiro:1', source: 'parceiro', is_vip: true }] })
      .mockResolvedValueOnce({ rows: [{ id: 'atacado:1', source: 'atacado', kind: 'borracharia' }] })
      .mockResolvedValueOnce({ rows: [{ partner_id: 'p1', name: 'Parceiro 1' }] });
    const pool = { query } as unknown as Pool;

    const result = await getClientesPainel('test', pool);

    expect(result.rows.map((row) => row.source)).toEqual(['chatwoot', 'balcao', 'parceiro', 'atacado']);
    expect(result.rows[2]?.is_vip).toBe(true);
    expect(result.partners).toHaveLength(1);
    expect(query).toHaveBeenCalledTimes(5);
    for (const call of query.mock.calls) expect(call[1]).toEqual(['test']);

    const sql = query.mock.calls.map((call) => String(call[0])).join('\n');
    expect(sql).toContain('core.contacts');
    expect(sql).toContain('commerce.customers');
    expect(sql).toContain('commerce.partner_customers');
    expect(sql).toContain('commerce.wholesale_buyer_summary');
    expect(sql).toContain('network.partners');
  });

  it('entrega as cinco subabas e mantém Clientes como item do menu existente', () => {
    const html = readFileSync('painel/public/index.html', 'utf8');
    const app = readFileSync('painel/public/app.js', 'utf8');
    const staticRoute = readFileSync('src/admin/painel/route-static.ts', 'utf8');

    for (const label of ['Todos', 'Leads', 'Compradores', 'Recompra', 'Parceiros']) {
      expect(html).toContain(`label:'${label}'`);
    }
    for (const bloco of ['versão fiel ao board aprovado', 'Lead selecionado', 'Margem estimada', 'Mensagem sugerida', 'Vínculo com parceiro']) {
      expect(html).toContain(bloco);
    }
    expect(app).toContain("{ id: 'clientes',   label: 'Clientes',   icon: 'users' }");
    expect(staticRoute).toContain("'app.clientes.js'");
  });
});
