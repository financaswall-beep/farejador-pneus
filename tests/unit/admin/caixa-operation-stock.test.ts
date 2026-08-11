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
  const stockDetail = source('painel/public/caixa-stock-detail.js');
  const stockEdit = source('painel/public/caixa-stock-edit.js');
  const style = source('painel/public/caixa.css');
  const stockView = source('painel/public/caixa-stock-view.js');
  const login = source('painel/public/caixa.js');
  const backend = source('src/parceiro/operation-stock.ts');
  const detailBackend = source('src/parceiro/operation-stock-detail.ts');
  const route = source('src/parceiro/route-operation-stock.ts');
  const detailRoute = source('src/parceiro/route-operation-stock-detail.ts');
  const updateRoute = source('src/parceiro/route-operation-stock-update.ts');
  const updateBackend = source('src/parceiro/operation-stock-update.ts');
  const legacyRoute = source('src/parceiro/route.ts');
  const appRoutes = source('src/app/routes.ts');
  const migration = source('db/migrations/0166_partner_operation_inventory_requests.sql');
  const countMigration = source('db/migrations/0167_partner_operation_count_batch_evidence.sql');
  const updateMigration = source('db/migrations/0168_partner_operation_stock_updates.sql');
  const receiptMigration = source('db/migrations/0169_partner_purchase_receiving.sql');
  const receiptUi = source('painel/public/caixa-stock-receipts.js');
  const receiptBackend = source('src/parceiro/operation-purchase-receipt.ts');
  const receiptRoute = source('src/parceiro/route-operation-purchases.ts');
  const purchaseQueries = source('src/parceiro/queries.ts');

  it('permite que um acesso apenas de estoque permaneça na porta única', () => {
    expect(modules).toContain("if (canModule('vendas')) return 'cash'");
    expect(modules).toContain("canModule('estoque')) return 'stock'");
    expect(login).not.toContain("payload.modules.vendas === false");
    expect(login).not.toContain("payload.permissions.vendas === false");
  });

  it('mostra consulta, cadastro sem valores e contagem pendente no mobile', () => {
    expect(html).toContain('id="stock-panel"');
    expect(html).toContain('Cadastrar produto');
    expect(html).toContain('Cadastrar serviço');
    expect(html).toContain('Fazer contagem');
    expect(html).toContain('id="stock-count-list"');
    expect(html).toContain('Enviar contagem para aprovação');
    expect(html).toContain('O saldo não será alterado sem aprovação do dono');
    expect(html).toContain('Sem valores financeiros');
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
    expect(style).not.toContain('.stock-card-condition--meia_vida');
    expect(style).not.toContain('.stock-card-condition--remold');
  });

  it('abre uma tela completa de detalhes com histórico real e custo protegido', () => {
    expect(html).toContain('id="stock-detail-panel"');
    expect(html).toContain('Detalhes do produto');
    expect(html).toContain('Estoque disponível');
    expect(html).toContain('Preço de venda');
    expect(html).toContain('Custo protegido pelo proprietário');
    expect(html).toContain('Últimas movimentações');
    expect(html).toContain('Ver histórico completo');
    expect(html).toContain('Toda movimentação fica registrada.');
    expect(stockView).toContain('data-stock-detail');
    expect(stockView).toContain('Caixa.openStockDetail');
    expect(stockDetail).toContain("Caixa.operationPath(path)");
    expect(stockDetail).toContain('Caixa.openStockCount(stockId)');
    expect(stockDetail).toContain('movementTitle');
    expect(stockDetail).not.toContain('average_cost');
    expect(detailBackend).toContain('sale_price');
    expect(detailBackend).not.toContain('average_cost');
    expect(detailBackend).toContain("'stock_decrement_sale'");
    expect(detailBackend).toContain("'stock_increment_purchase'");
    expect(detailBackend).toContain("'partner_stock_count_approved'");
    expect(detailBackend).toContain("movement->>'stock_id'=$2::text");
    expect(detailRoute).toContain("'/parceiro/:slug/api/operacao/estoque/:stockId'");
    expect(detailRoute).toContain("requireScreen('estoque')");
    expect(appRoutes).toContain('registerPartnerOperationStockDetailRoutes');
  });

  it('separa produto e serviço usando o mesmo contrato seguro de cadastro', () => {
    expect(stock).toContain("openRegister('pneu')");
    expect(stock).toContain("openRegister('servico')");
    expect(stock).toContain("type === 'servico' ? null : nullable");
    expect(stock).toContain('O dono define custo e preço antes de liberar para venda.');
    expect(stock).toContain('Salvar serviço e enviar para aprovação');
    expect(html).not.toContain('Duração estimada');
    expect(html).not.toContain('Consome material cadastrado');
  });

  it('edita somente o cadastro operacional e envia para aprovação do dono', () => {
    expect(html).toContain('id="stock-edit-modal"');
    expect(html).toContain('Tipo, saldo, custo e preço não podem ser alterados aqui.');
    expect(stockDetail).toContain('Caixa.openStockEdit(state.stock)');
    expect(stockDetail).toContain('row.update_pending');
    expect(stockEdit).toContain('/edicoes`');
    expect(stockEdit).not.toContain('average_cost');
    expect(stockEdit).not.toContain('sale_price');
    expect(stockEdit).not.toContain('quantity_on_hand');
    expect(updateRoute).toContain("requireScreen('estoque')");
    expect(updateRoute).toContain('requireOwner');
    expect(updateBackend).toContain("'partner_stock_update_approved'");
    expect(updateBackend).not.toMatch(/SET[\s\S]{0,300}average_cost/);
    expect(updateBackend).not.toMatch(/SET[\s\S]{0,300}sale_price/);
    expect(updateBackend).not.toMatch(/SET[\s\S]{0,300}quantity_on_hand\s*=/);
    expect(updateMigration).toContain('partner_item_update_one_pending_idx');
    expect(updateMigration).toContain('stock_metadata_snapshot');
  });

  it('usa uma API segura que não devolve custo nem grava saldo oficial', () => {
    expect(stock).toContain("Caixa.operationPath('operacao/estoque')");
    expect(stock).toContain("'operacao/estoque/cadastros'");
    expect(stockCount).toContain("operacao/estoque/contagens/lote");
    expect(stockCount).toContain('counted_quantity');
    expect(stockCount).toContain('reason_detail');
    expect(stockCount).toContain('/foto`');
    expect(backend).not.toContain('average_cost');
    expect(backend).not.toContain('sale_price');
    expect(detailBackend).not.toContain('average_cost');
    expect(backend).not.toContain('UPDATE commerce.partner_stock_levels');
    expect(detailBackend).not.toContain('UPDATE commerce.partner_stock_levels');
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

  it('recebe compra com quantidades, sem revelar valores ao funcionário', () => {
    expect(html).toContain('id="stock-receipts-open"');
    expect(html).toContain('id="stock-receipts-panel"');
    expect(html).toContain('Custos e valores da compra ficam ocultos');
    expect(html).toContain('Conferi os produtos e as quantidades');
    expect(receiptUi).toContain("Caixa.operationPath('operacao/compras')");
    expect(receiptUi).toContain('received_quantity');
    expect(receiptUi).not.toContain('unit_cost');
    expect(receiptUi).not.toContain('sale_price');
    expect(receiptRoute).toContain("requireScreen('estoque')");
    expect(receiptRoute).toContain('api/operacao/compras/:purchaseId/receber');
    expect(receiptBackend).toContain("receipt_status='pending'");
    expect(receiptBackend).toContain('receipt_idempotency_key');
    expect(receiptMigration).toContain("CHECK (receipt_status IN ('pending', 'received'))");
    expect(receiptMigration).toContain('received_quantity');
  });

  it('não movimenta estoque ao registrar; só na confirmação do recebimento', () => {
    const registerBlock = purchaseQueries.slice(
      purchaseQueries.indexOf('export async function registerPartnerPurchase'),
      purchaseQueries.indexOf('export async function deletePartnerPurchase'),
    );
    expect(registerBlock).toContain('receipt_status');
    expect(registerBlock).toContain("'pending'");
    expect(registerBlock).not.toContain('UPDATE commerce.partner_stock_levels');
    expect(registerBlock).not.toContain('INSERT INTO commerce.partner_stock_levels');
    expect(legacyRoute).toContain("fastify.post('/parceiro/:slug/api/compras', { preHandler: ownerOnly }");
    expect(legacyRoute).toContain("fastify.delete('/parceiro/:slug/api/compras/:purchaseId', { preHandler: ownerOnly }");
  });
});
