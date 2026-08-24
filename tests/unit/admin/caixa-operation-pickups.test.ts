import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(file: string): string {
  return readFileSync(resolve(file), 'utf8');
}

describe('Retiradas dentro da Operação da Loja', () => {
  const html = source('painel/public/caixa.html');
  const modules = source('painel/public/caixa-modules.js');
  const navigation = source('painel/public/caixa-sales.js');
  const ui = source('painel/public/caixa-pickups-actions.js');
  const core = source('painel/public/caixa-pickups-core.js');
  const css = source('painel/public/caixa.css');
  const matrixRoute = source('src/admin/caixa/route-pickups.ts');
  const caixaRoute = source('src/admin/caixa/route.ts');
  const partnerRoute = source('src/parceiro/route.ts');
  const operationAuth = source('src/admin/caixa/operation-auth.ts');

  it('acrescenta a aba no casco existente sem criar outro aplicativo', () => {
    expect(html).toContain('id="pickups-panel"');
    expect(html).toContain('id="nav-pickups"');
    expect(html).toContain('/operacao/caixa-pickups-core.js?v=20260823-pickups-layout2');
    expect(html).toContain('/operacao/caixa-pickups-sheet.js?v=20260823-pickups-layout2');
    expect(html).toContain('/operacao/caixa-pickups-actions.js?v=20260823-pickups-layout2');
    expect(modules).toContain("pickups: 'retiradas'");
    expect(modules).toContain("setNavigationVisibility('nav-pickups', canModule('retiradas'))");
    expect(navigation).toContain("showTab('pickups')");
  });

  it('mantém uma única família de regras e troca somente a rota pelo escopo', () => {
    expect(ui).toContain("Caixa.operationPath('retiradas', '/api/caixa/retiradas')");
    expect(ui).toContain("method: 'PUT'");
    expect(ui).toContain("method: 'POST'");
    expect(ui).toContain("method: 'DELETE'");
    expect(partnerRoute).toContain("requireScreen('retiradas')");
    expect(matrixRoute).toContain('completeMatrizPickup');
    expect(matrixRoute).toContain('cancelMatrizPickup');
  });

  it('protege a Matriz com módulo próprio e não converte Vendas em Retiradas', () => {
    expect(caixaRoute).toContain("requireCaixaModule('retiradas')");
    expect(matrixRoute).toContain('requirePickups');
    expect(operationAuth).toContain('retiradas: false');
    expect(operationAuth).toContain('retiradas: true');
    expect(operationAuth).toContain('allow_retiradas');
  });

  it('só promete alterar estoque e caixa na confirmação final', () => {
    expect(html).toContain('Estoque e caixa só mudam após a confirmação final.');
    expect(ui).toContain('Retirada concluída. Estoque e caixa confirmados juntos.');
    expect(ui).toContain('A reserva foi liberada sem lançar caixa.');
  });

  it('mantém os quatro indicadores e as ações finais visíveis no celular', () => {
    expect(css).toContain('.pickups-kpis { gap: 5px; }');
    expect(css).not.toContain('.pickups-kpis { grid-template-columns: repeat(2,minmax(0,1fr)); }');
    expect(css).toContain('.pickups-sheet-actions { position: sticky;');
    expect(core).toContain("'Reservado em ' + Caixa.dateTime.format(instant)");
    expect(core).toContain("'Sem WhatsApp'");
    expect(html).toContain('data-pickup-payment="Pix"');
  });
});
