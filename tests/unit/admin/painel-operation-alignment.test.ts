import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (file: string) => readFileSync(resolve(file), 'utf8');

describe('alinhamento dos painéis administrativos com a Operação da Loja', () => {
  const matrixHtml = source('painel/public/index.html');
  const matrixUi = source('painel/public/app.colaboradores.gestao.js');
  const matrixPermissions = source('painel/public/app.colaboradores.permissions.js');
  const matrixRoutes = source('src/admin/painel/route-colaboradores-gestao.ts');
  const partnerHtml = source('parceiro/public/index.html');
  const partnerUi = source('parceiro/public/app.config.equipe.js');

  it('permite configurar na Matriz os mesmos campos existentes no app', () => {
    expect(matrixHtml).toContain('Permissões do app');
    expect(matrixHtml).toContain('Frequência do salário');
    expect(matrixHtml).toContain('Benefícios e adicionais');
    expect(matrixHtml).toContain('Regra por tipo de item');
    expect(matrixHtml).toContain('Fechamento da comissão');
    expect(matrixUi).toContain('salary_frequency:');
    expect(matrixUi).toContain('settlement_frequency:');
    expect(matrixUi).toContain('item_rules:');
    expect(matrixPermissions).toContain('/permissoes-operacao`');
    expect(matrixRoutes).toContain("fastify.get('/admin/api/colaboradores/:collaboratorId/permissoes-operacao'");
    expect(matrixRoutes).toContain("fastify.put('/admin/api/colaboradores/:collaboratorId/permissoes-operacao'");
  });

  it('usa no painel parceiro as APIs operacionais como fonte única', () => {
    expect(partnerUi).toContain('`equipe/${f.id}/permissoes`');
    expect(partnerUi).toContain('`equipe/${f.id}/remuneracao`');
    expect(partnerUi).toContain('`equipe/${f.id}/comissao`');
    expect(partnerUi).toContain('`equipe/${f.id}/configuracao`');
    expect(partnerUi).toContain('batepapo: !!this.funcPermForm.batepapo');
    expect(partnerHtml).toContain('Salário base');
    expect(partnerHtml).toContain('Fechamento');
    expect(partnerHtml).toContain('Por tipo de item');
  });

  it('não oferece comissão por item ao entregador da Matriz', () => {
    expect(matrixUi).toContain("itemized: c.work_area !== 'delivery'");
    expect(matrixHtml).toContain("x-show=\"colabSelected?.work_area !== 'delivery'\"");
  });
});
