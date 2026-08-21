import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(file: string): string {
  return readFileSync(resolve(file),'utf8');
}

describe('guardas de dono nos fatos financeiros da Matriz', () => {
  it('fecha todos os atalhos antigos de despesas e recebimento de comissao', () => {
    const finance = source('src/admin/painel/route-financeiro.ts');
    const wholesale = source('src/admin/painel/route-atacado.ts');
    for (const path of [
      '/admin/api/matriz/despesas/categorias',
      '/admin/api/matriz/despesas/categorias/arquivar',
      '/admin/api/matriz/despesas',
      '/admin/api/matriz/despesas/settle',
      '/admin/api/matriz/despesas/remove',
    ]) {
      expect(finance).toContain(`post('${path}', { preHandler: requireAdminOwner }`);
    }
    expect(wholesale).toContain(
      "post('/admin/api/rede/comissoes/settle', { preHandler: requireAdminOwner }",
    );
    expect(wholesale).toContain(
      "post('/admin/api/rede/custos/reconcile', { preHandler: requireAdminOwner }",
    );
    expect(wholesale).toContain(
      "post('/admin/api/partners/:partner_id/terms', { preHandler: requireAdminOwner }",
    );
  });

  it('deixa consulta do catalogo aberta ao admin, mas criacao e preco so ao dono', () => {
    const catalog = source('src/admin/painel/route-catalogo.ts');
    expect(catalog).toContain(
      "get('/admin/api/catalog', { preHandler: requireAdminAuth }",
    );
    expect(catalog).toContain(
      "post('/admin/api/catalog/products', { preHandler: requireAdminOwner }",
    );
    expect(catalog).toContain(
      "post('/admin/api/catalog/:product_id/price', { preHandler: requireAdminOwner }",
    );
  });
});
