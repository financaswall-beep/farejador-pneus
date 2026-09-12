import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Clientes - Kanban operacional', () => {
  it('move por arrastar e por seletor, arquiva sem excluir e limita cada coluna', () => {
    const html = readFileSync('painel/public/index.html','utf8');
    const ui = readFileSync('painel/public/app.clientes.kanban.js','utf8');
    const route = readFileSync('src/admin/painel/route-clientes.ts','utf8');
    const migration = readFileSync('db/migrations/0196_customer_lead_board.sql','utf8');

    expect(html).toContain('@dragstart="clienteLeadDragStart(c,$event)"');
    expect(html).toContain('@drop.prevent="clienteLeadDrop(lane.id)"');
    expect(html).toContain('alterarClienteLeadLane(clienteLeadSelecionado(),$event.target.value)');
    expect(html).toContain('★ VIP');
    expect(html.includes('Arquivar lead')).toBe(true);
    expect(html.includes('Restaurar lead')).toBe(true);
    expect(ui).toContain("alert('Convertido é automático");
    expect(ui).toContain('clientesLeadsVisiveis');
    expect(ui).toContain("method: 'PATCH'");
    expect(route).toContain("fastify.patch('/admin/api/clientes/leads/:conversationId'");
    expect(migration).toContain('ON DELETE RESTRICT');
    expect(migration).not.toContain('ON DELETE CASCADE');
  });
});
