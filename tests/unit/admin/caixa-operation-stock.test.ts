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
  const stockCount = source('painel/public/caixa-stock-count.js');
  const style = source('painel/public/caixa.css');
  const stockView = source('painel/public/caixa-stock-view.js');
  const login = source('painel/public/caixa.js');
  const backend = source('src/parceiro/operation-stock.ts');
  const route = source('src/parceiro/route-operation-stock.ts');
  const legacyRoute = source('src/parceiro/route.ts');
  const appRoutes = source('src/app/routes.ts');
  const migration = source('db/migrations/0166_partner_operation_inventory_requests.sql');
  const countMigration = source('db/migrations/0167_partner_operation_count_batch_evidence.sql');

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
    expect(html).toContain('id="stock-count-list"');
    expect(html).toContain('Enviar contagem para aprovação');
    expect(html).toContain('O saldo não será alterado sem aprovação do dono');
    expect(html).toContain('Sem custo, preço ou saldo');
    expect(html).toContain('O saldo oficial não muda sozinho');
    expect(html).not.toContain('id="stock-item-cost"');
    expect(html).not.toContain('id="stock-item-price"');
    expect(html).not.toContain('id="stock-item-quantity"');
    expect(stockView).toContain("image.src = '/caixa/catalog-tire.webp'");
    expect(stockView).toContain("row.tire_size || row.item_name");
    expect(stockView).toContain("conditionLabel(row.tire_condition) || 'Condição a confirmar'");
    expect(stockView).toContain("actions.appendChild(stockBadge(row))");
    expect(stockView).toContain("if (count) actions.appendChild(count)");
    expect(style).toContain('.stock-card-content--tire');
    expect(style).toContain('.stock-card-brand');
    expect(style).toContain('.stock-card-condition--meia_vida');
  });

  it('usa uma API segura que nunca devolve ou grava custo e preço', () => {
    expect(stock).toContain("Caixa.operationPath('operacao/estoque')");
    expect(stock).toContain("'operacao/estoque/cadastros'");
    expect(stockCount).toContain("operacao/estoque/contagens/lote");
    expect(stockCount).toContain('counted_quantity');
    expect(stockCount).toContain('reason_detail');
    expect(stockCount).toContain('/foto`');
    expect(backend).not.toContain('average_cost');
    expect(backend).not.toContain('sale_price');
    expect(backend).not.toContain('UPDATE commerce.partner_stock_levels');
    expect(route).toContain(".strict().superRefine");
    expect(route).toContain("requireScreen('estoque')");
  });

  it('prioriza a medida e alinha saldo com quantidade na contagem mobile', () => {
    expect(stockCount).toContain("row.item_type === 'pneu' && row.tire_size ? row.tire_size : row.item_name");
    expect(stockCount).toContain("brand.className = 'stock-count-brand'");
    expect(stockCount).toContain("systemLabel.textContent = 'Saldo no sistema'");
    expect(stockCount).toContain("countedLabel.textContent = 'Quantidade contada'");
    expect(style).toContain('"system-label counted-label"');
    expect(style).toContain('"system stepper"');
    expect(style).toMatch(/\.stock-count-brand[^}]*font-size: 14px/);
    expect(style).toMatch(/\.stock-count-field-label[^}]*font-size: 9px/);
    expect(style).toMatch(/\.stock-count-system-box b[^}]*font-size: 16px/);
    expect(style).toMatch(/\.stock-count-stepper input[^}]*font-size: 17px/);
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

  it('corrige a validação do token sem abrir a tabela de credenciais', () => {
    expect(countMigration).toContain('validate_partner_operation_request_actor');
    expect(countMigration).toContain('SECURITY DEFINER');
    expect(countMigration).toContain('DROP TRIGGER IF EXISTS env_match_partner_stock_count_token');
    expect(countMigration).toContain('partner_request_actor_invalid');
    expect(countMigration).toContain('partner_stock_count_evidence');
    expect(countMigration).not.toContain('GRANT SELECT ON network.partner_access_tokens');
  });

  it('fecha o atalho antigo que alterava o estoque oficial para funcionários', () => {
    expect(legacyRoute).toContain("fastify.get('/parceiro/:slug/api/estoque', { preHandler: ownerOnly }");
    expect(legacyRoute).toContain("fastify.post('/parceiro/:slug/api/estoque', { preHandler: ownerOnly }");
    expect(legacyRoute).toContain("fastify.delete('/parceiro/:slug/api/estoque/:stockId', { preHandler: ownerOnly }");
  });
});
