import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (file: string) => readFileSync(resolve(file), 'utf8');

describe('fila de aprovação do estoque no painel do dono', () => {
  const html = source('parceiro/public/index.html');
  const app = source('parceiro/public/app.estoque.aprovacoes.js');
  const route = source('src/parceiro/route-operation-stock.ts');
  const updateRoute = source('src/parceiro/route-operation-stock-update.ts');
  const backend = source('src/parceiro/operation-stock-owner.ts');
  const updateBackend = source('src/parceiro/operation-stock-update.ts');
  const migration = source('db/migrations/0166_partner_operation_inventory_requests.sql');
  const evidenceMigration = source('db/migrations/0167_partner_operation_count_batch_evidence.sql');
  const purchases = source('parceiro/public/app.financeiro.compras.js');

  it('oferece filtros e revisão separada para cadastros, edições e contagens', () => {
    expect(html).toContain('Aprovar alterações do estoque');
    expect(html).toContain("stockAdminTab === 'requests'");
    expect(html).toContain('Cadastros pendentes');
    expect(html).toContain('Contagens pendentes');
    expect(html).toContain('Edições pendentes');
    expect(html).toContain('Aprovar alteração');
    expect(app).toContain('stockPendingUpdates');
    expect(app).toContain('stockUpdateFields');
    expect(html).toContain('Nada altera saldo, custo ou preço sem sua aprovação');
    expect(html).toContain('Aprovar e cadastrar');
    expect(html).toContain('Aprovar contagem');
    expect(html).toContain('Foto enviada pelo funcionário');
    expect(app).toContain('stock-count:${item.id}');
    expect(backend).toContain('has_evidence');
    expect(html).toContain("'Custo do serviço' : 'Custo unitário'");
    expect(html).toContain("'Preço cobrado' : 'Preço de venda'");
    expect(html).toContain("x-show=\"stockApprovalItem?.item_type !== 'servico'\">Fornecedor");
  });

  it('mantém a fila e as decisões exclusivamente para o dono', () => {
    expect(html).toContain('x-show="isOwner"');
    expect(route).toContain('const ownerOnly = [requirePartnerAuth, requireOwner]');
    expect(route).toContain("api/operacao/estoque/solicitacoes', { preHandler: ownerOnly }");
    expect(route.match(/preHandler: ownerOnly/g)?.length).toBeGreaterThanOrEqual(4);
    expect(updateRoute).toContain('preHandler: [requirePartnerAuth, requireOwner]');
  });

  it('exige preço/custo na aprovação e trata conflito de contagem', () => {
    expect(app).toContain('average_cost');
    expect(app).toContain('sale_price');
    expect(app).toContain("code === 'stock_count_stale'");
    expect(backend).toContain('FOR UPDATE OF r, s');
    expect(backend).toContain("throw new OperationStockReviewError('stock_count_stale'");
    expect(backend).toContain('INSERT INTO audit.events');
    expect(updateBackend).toContain("'stock_update_stale'");
    expect(updateBackend).toContain("'partner_stock_update_approved'");
    expect(updateBackend).not.toMatch(/SET[\s\S]{0,300}average_cost/);
    expect(updateBackend).not.toMatch(/SET[\s\S]{0,300}sale_price/);
  });

  it('persiste o instante observado e o vínculo do cadastro aprovado', () => {
    expect(migration).toContain('stock_updated_at_snapshot TIMESTAMPTZ NOT NULL');
    expect(migration).toContain('approved_stock_id');
    expect(migration).toContain('partner_item_registration_stock');
    expect(evidenceMigration).toContain('partner_stock_count_evidence');
  });

  it('dá ao dono uma fila de compras sem antecipar a entrada no estoque', () => {
    expect(html).toContain("stockAdminTab === 'purchases'");
    expect(html).toContain('Compras e recebimentos');
    expect(html).toContain('Aguardando recebimento');
    expect(html).toContain('Registrar e enviar para recebimento');
    expect(html).toContain('Valores visíveis só para o dono');
    expect(purchases).toContain('purchasesPendingReceipt');
    expect(purchases).toContain('Mercadoria aguardando conferência da equipe.');
    expect(purchases).not.toContain('Compra registrada e estoque atualizado.');
  });
});
