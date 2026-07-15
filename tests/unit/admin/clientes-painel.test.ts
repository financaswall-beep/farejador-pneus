import { readFileSync } from 'node:fs';
import type { Pool, PoolClient } from 'pg';
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
    expect(sql).toContain('latest_conversation');
    expect(sql).toContain("THEN 'convertido'");
    expect(sql).toContain("current_status = 'resolved'");
    expect(sql).toContain('source_conversation_id = lc.conversation_id');
    expect(sql).not.toContain("max(ac.value) FILTER (WHERE ac.dimension = 'stage_reached')");
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
    expect(html).toContain("id:'convertido',label:'Convertidos'");
    expect(html).toContain("id:'perdido',label:'Perdidos'");
    expect(html).toContain("panel:'bg-rose-100 border-rose-300'");
    expect(html).toContain("panel:'bg-emerald-100 border-emerald-300'");
  });

  it('emite a invalidação do Kanban com ambiente, conversa e motivo', async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test', FAREJADOR_ENV: 'test',
      DATABASE_URL: 'postgresql://postgres:password@example.test:6543/postgres',
      CHATWOOT_HMAC_SECRET: 'test-secret', ADMIN_AUTH_TOKEN: 'test-admin-token',
    });
    const { notifyClientesKanban } = await import('../../../src/shared/clientes-kanban.notify.js');
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const client = { query } as unknown as PoolClient;

    await notifyClientesKanban(client, 'prod', 'conv-123', 'agent_turn');

    expect(query).toHaveBeenCalledWith('SELECT pg_notify($1, $2)', [
      'clientes_kanban',
      JSON.stringify({ environment: 'prod', conversation_id: 'conv-123', reason: 'agent_turn' }),
    ]);
  });

  it('liga SSE com debounce de um segundo e fallback sem tirar os cards da tela', () => {
    const clientes = readFileSync('painel/public/app.clientes.js', 'utf8');
    const core = readFileSync('painel/public/app.core.js', 'utf8');
    const route = readFileSync('src/admin/painel/route-clientes.ts', 'utf8');

    expect(clientes).toContain("new EventSource('/admin/api/clientes/stream')");
    expect(clientes).toContain('setTimeout(() => { void app.loadClientes(true); }, 1000)');
    expect(clientes).toContain('}, 15000)');
    expect(core).toContain('this.startClientesLive()');
    expect(core).toContain('this.stopClientesLive()');
    expect(route).toContain("'Content-Type': 'text/event-stream'");
    expect(route).toContain("event: kanban");
  });
});
