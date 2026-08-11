import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(file: string): string {
  return readFileSync(resolve(file), 'utf8');
}

describe('Estoque seguro na Operação da Loja', () => {
  const html = source('painel/public/caixa.html');
  const modules = source('painel/public/caixa-modules.js');
  const stock = source('painel/public/caixa-stock.js');
  const stockView = source('painel/public/caixa-stock-view.js');
  const login = source('painel/public/caixa.js');
  const backend = source('src/parceiro/operation-stock.ts');
  const route = source('src/parceiro/route-operation-stock.ts');
  const legacyRoute = source('src/parceiro/route.ts');
  const appRoutes = source('src/app/routes.ts');
  const migration = source('db/migrations/0166_partner_operation_inventory_requests.sql');

  it('permite que um acesso apenas de estoque permaneça na porta única', () => {
    expect(modules).toContain("if (canModule('vendas')) return 'cash'");
    expect(modules).toContain("canModule('estoque')) return 'stock'");
    expect(login).not.toContain("payload.modules.vendas === false");
    expect(login).not.toContain("payload.permissions.vendas === false");
  });

  it('mostra consulta, cadastro sem valores e contagem pendente no mobile', () => {
    expect(html).toContain('id="stock-panel"');
    expect(html).toContain('Cadastrar item');
    expect(html).toContain('Fazer contagem');
    expect(html).toContain('Sem custo, preço ou saldo');
    expect(html).toContain('O saldo oficial não muda sozinho');
    expect(html).not.toContain('id="stock-item-cost"');
    expect(html).not.toContain('id="stock-item-price"');
    expect(html).not.toContain('id="stock-item-quantity"');
    expect(stockView).toContain("image.src = '/caixa/catalog-tire.webp'");
  });

  it('usa uma API segura que nunca devolve ou grava custo e preço', () => {
    expect(stock).toContain("Caixa.operationPath('operacao/estoque')");
    expect(stock).toContain("'operacao/estoque/cadastros'");
    expect(stock).toContain("'operacao/estoque/contagens'");
    expect(backend).not.toContain('average_cost');
    expect(backend).not.toContain('sale_price');
    expect(backend).not.toContain('UPDATE commerce.partner_stock_levels');
    expect(route).toContain(".strict().superRefine");
    expect(route).toContain("requireScreen('estoque')");
  });

  it('grava solicitações isoladas por unidade e sem permissão de autoaprovação', () => {
    expect(migration).toContain('partner_item_registration_requests');
    expect(migration).toContain('partner_stock_count_requests');
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('GRANT SELECT, INSERT');
    expect(migration).toContain('REVOKE UPDATE, DELETE');
    expect(migration).toContain("status = 'pending'");
    expect(appRoutes).toContain('registerPartnerOperationStockRoutes');
  });

  it('fecha o atalho antigo que alterava o estoque oficial para funcionários', () => {
    expect(legacyRoute).toContain("fastify.get('/parceiro/:slug/api/estoque', { preHandler: ownerOnly }");
    expect(legacyRoute).toContain("fastify.post('/parceiro/:slug/api/estoque', { preHandler: ownerOnly }");
    expect(legacyRoute).toContain("fastify.delete('/parceiro/:slug/api/estoque/:stockId', { preHandler: ownerOnly }");
  });
});
