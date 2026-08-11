import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (file: string) => readFileSync(resolve(file), 'utf8');

describe('fila de aprovação do estoque no painel do dono', () => {
  const html = source('parceiro/public/index.html');
  const app = source('parceiro/public/app.estoque.aprovacoes.js');
  const route = source('src/parceiro/route-operation-stock.ts');
  const backend = source('src/parceiro/operation-stock-owner.ts');
  const migration = source('db/migrations/0166_partner_operation_inventory_requests.sql');
  const evidenceMigration = source('db/migrations/0167_partner_operation_count_batch_evidence.sql');

  it('oferece abas, filtros e revisão separada para cadastros e contagens', () => {
    expect(html).toContain('Aprovar alterações do estoque');
    expect(html).toContain("stockAdminTab === 'requests'");
    expect(html).toContain('Cadastros pendentes');
    expect(html).toContain('Contagens pendentes');
    expect(html).toContain('Nada altera saldo, custo ou preço sem sua aprovação');
    expect(html).toContain('Aprovar e cadastrar');
    expect(html).toContain('Aprovar contagem');
    expect(html).toContain('Foto enviada pelo funcionário');
    expect(app).toContain('stock-count:${item.id}');
    expect(backend).toContain('has_evidence');
  });

  it('mantém a fila e as decisões exclusivamente para o dono', () => {
    expect(html).toContain('x-show="isOwner"');
    expect(route).toContain('const ownerOnly = [requirePartnerAuth, requireOwner]');
    expect(route).toContain("api/operacao/estoque/solicitacoes', { preHandler: ownerOnly }");
    expect(route.match(/preHandler: ownerOnly/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('exige preço/custo na aprovação e trata conflito de contagem', () => {
    expect(app).toContain('average_cost');
    expect(app).toContain('sale_price');
    expect(app).toContain("code === 'stock_count_stale'");
    expect(backend).toContain('FOR UPDATE OF r, s');
    expect(backend).toContain("throw new OperationStockReviewError('stock_count_stale'");
    expect(backend).toContain('INSERT INTO audit.events');
  });

  it('persiste o instante observado e o vínculo do cadastro aprovado', () => {
    expect(migration).toContain('stock_updated_at_snapshot TIMESTAMPTZ NOT NULL');
    expect(migration).toContain('approved_stock_id');
    expect(migration).toContain('partner_item_registration_stock');
    expect(evidenceMigration).toContain('partner_stock_count_evidence');
  });
});
